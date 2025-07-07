import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '@/lib/db/prisma';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

export class GmailService {
  private oauth2Client: OAuth2Client;
  private userId: string;

  constructor(userId: string) {
    this.userId = userId;
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
  }

  private async getAuthClient() {
    const account = await prisma.account.findFirst({
      where: { userId: this.userId, provider: 'google' },
    });

    if (!account?.access_token) {
      throw new Error('No access token found');
    }

    this.oauth2Client.setCredentials({
      access_token: account.access_token,
      refresh_token: account.refresh_token,
      expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
    });

    // Refresh token if expired
    if (account.expires_at && account.expires_at * 1000 < Date.now()) {
      const { credentials } = await this.oauth2Client.refreshAccessToken();

      // Update the token in the database
      await prisma.account.update({
        where: { id: account.id },
        data: {
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token || account.refresh_token,
          expires_at: credentials.expiry_date ? Math.floor(credentials.expiry_date / 1000) : null,
        },
      });
    }

    return this.oauth2Client;
  }

  async getGmailClient() {
    const auth = await this.getAuthClient();
    return google.gmail({ version: 'v1', auth });
  }

  async searchEmails(query: string, maxResults = 50, pageToken?: string) {
    const gmail = await this.getGmailClient();

    // 1. Build your keyword clause from an array (so it’s easier to see each term)
    const keywords = [
      'invoice',
      'receipt',
      'bill',
      'payment',
      '"purchase order"',
      '"sales order"',
      '"tax invoice"',
      'statement',
      '"order confirmation"',
    ].join(' OR ');

    // 2. Date spec (one year ago from today, i.e. July 8 2024)
    const dateSpec = 'after:2024/07/08';

    // 3. “Anywhere” spec
    const anywhere = 'in:anywhere';

    // 4. Combine them into _one_ flat string, with a single space between each piece
    const fullQuery = `${anywhere} ${dateSpec} (${keywords})`;

    // 5. (Optional) Strip any accidental newlines/multi-spaces
    const cleanQuery = fullQuery.replace(/\s+/g, ' ').trim();

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: cleanQuery,
      maxResults,
      pageToken,
    });

    return {
      messages: response.data.messages || [],
      nextPageToken: response.data.nextPageToken,
      resultSizeEstimate: response.data.resultSizeEstimate,
    };
  }

  async getMessage(messageId: string) {
    const gmail = await this.getGmailClient();

    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    return response.data;
  }

  private htmlToText(html: string): string {
    // Simple HTML to text conversion
    return html
      .replace(/<[^>]+>/g, ' ') // Remove HTML tags
      .replace(/\s+/g, ' ')     // Collapse multiple spaces
      .replace(/&nbsp;/g, ' ')   // Replace non-breaking spaces
      .replace(/&[a-z]+;/g, '')  // Remove other HTML entities
      .trim();
  }

  private getPartData(part: any): { type: string; data: string } | null {
    if (part.body?.data) {
      return {
        type: part.mimeType || 'text/plain',
        data: Buffer.from(part.body.data, 'base64').toString('utf-8')
      };
    }
    return null;
  }

  async getMessageBody(message: any): Promise<string> {
    if (!message.payload) return '';

    let plainText = '';
    let htmlContent = '';

    // Helper function to process parts recursively
    const processPart = (part: any) => {
      // Check if this part has data
      const partData = this.getPartData(part);
      if (partData) {
        if (partData.type === 'text/plain') {
          plainText = partData.data;
        } else if (partData.type === 'text/html' && !plainText) {
          // Only use HTML if we haven't found plain text yet
          htmlContent = partData.data;
        }
      }

      // Process nested parts
      if (part.parts) {
        part.parts.forEach(processPart);
      }
    };

    // Start processing from the root
    processPart(message.payload);

    // Return plain text if found, otherwise convert HTML to text, otherwise empty string
    if (plainText) {
      return plainText;
    } else if (htmlContent) {
      return this.htmlToText(htmlContent);
    }

    // Fallback to the body data if no parts
    if (message.payload.body?.data) {
      return Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    }

    return '';
  }

  async getAttachments(message: any) {
    if (!message.payload?.parts) return [];

    const attachments = [];
    const gmail = await this.getGmailClient();

    for (const part of message.payload.parts) {
      try {
        // Skip if not an attachment or no filename
        if (!part.filename || !part.filename.trim() || !part.body?.attachmentId) continue;

        // Skip large attachments (>5MB) to avoid memory issues
        const size = parseInt(part.body.size || '0');
        if (size > 5 * 1024 * 1024) { // 5MB limit
          console.log(`Skipping large attachment: ${part.filename} (${Math.round(size / 1024 / 1024)}MB)`);
          continue;
        }

        // Get the attachment data
        const response = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: message.id,
          id: part.body.attachmentId,
        });

        // Only include relevant file types
        const mimeType = part.mimeType?.toLowerCase() || '';
        const filename = part.filename.toLowerCase();

        // Check if file is a PDF by MIME type or extension
        const isPdf = mimeType === 'application/pdf' || filename.endsWith('.pdf');

        // Check if file has a supported extension
        const hasSupportedExtension = [
          '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png'
        ].some(ext => filename.endsWith(ext));

        // Check if MIME type is in our supported list
        const isSupportedMimeType = [
          'application/pdf',
          'text/plain',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'image/jpeg',
          'image/png',
        ].some(type => mimeType.startsWith(type));

        // Accept the file if it's explicitly a PDF or has a supported MIME type/extension
        const shouldAcceptFile = isPdf || isSupportedMimeType || hasSupportedExtension;

        if (!shouldAcceptFile) {
          console.log(`Skipping unsupported file: ${part.filename} (${mimeType})`);
          continue;
        }

        attachments.push({
          filename: part.filename,
          mimeType: mimeType,
          size: size,
          data: response.data.data, // Base64 encoded data
        });
      } catch (error) {
        console.error(`Error processing attachment ${part.filename}:`, error);
        continue;
      }
    }

    return attachments;
  }

  async markAsProcessed(messageId: string) {
    const gmail = await this.getGmailClient();
    const labelName = 'INVOICE_PROCESSED';

    try {
      // First, try to create the label if it doesn't exist
      let labelId: string | undefined;

      try {
        const labelsRes = await gmail.users.labels.list({ userId: 'me' });
        const existingLabel = labelsRes.data.labels?.find(label => label.name === labelName);

        if (!existingLabel) {
          const createRes = await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
              name: labelName,
              labelListVisibility: 'labelShow',
              messageListVisibility: 'show',
            },
          });
          labelId = createRes.data.id!;
        } else {
          labelId = existingLabel.id!;
        }
      } catch (error) {
        console.warn('Failed to create label, proceeding without it:', error);
      }

      // Now modify the message with the label
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          addLabelIds: labelId ? [labelId] : [],
          removeLabelIds: ['UNREAD', 'INBOX'],
        },
      });
    } catch (error) {
      console.error('Error in markAsProcessed:', error);
      throw error;
    }
  }
}
