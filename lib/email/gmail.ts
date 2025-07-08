import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/db/prisma";
import type {
  GmailMessage,
  GmailMessagePart,
  GmailMessageListResponse,
  GmailAttachment,
} from "./types";

// SCOPES constant removed as it's not being used

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
      where: { userId: this.userId, provider: "google" },
    });

    if (!account?.access_token) {
      throw new Error("No access token found");
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
          expires_at: credentials.expiry_date
            ? Math.floor(credentials.expiry_date / 1000)
            : null,
        },
      });
    }

    return this.oauth2Client;
  }

  async getGmailClient() {
    const auth = await this.getAuthClient();
    return google.gmail({ version: "v1", auth });
  }

  async searchEmails(
    maxResults = 500,
    pageToken?: string
  ): Promise<GmailMessageListResponse> {
    const gmail = await this.getGmailClient();
    // 5. Combine them into _one_ flat string, with a single space between each piece
    const cleanQuery = `to:hillierliam37@gmail.com newer_than:1y (subject:(invoice OR receipt OR purchase OR order OR confirmation OR payment) OR body:(invoice OR receipt OR "order confirmation" OR "purchase confirmation" OR payment OR "tax invoice")) -{"uber eats" uber ubereats}
`;
    const response = await gmail.users.messages.list({
      userId: "me",
      q: cleanQuery,
      maxResults,
      pageToken,
    });

    // Ensure we have a valid response with messages
    const messages = (response.data.messages || []).filter(
      (msg): msg is { id: string; threadId: string } =>
        !!msg.id && !!msg.threadId
    );

    return {
      messages,
      nextPageToken: response.data.nextPageToken || undefined,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
    };
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    const gmail = await this.getGmailClient();

    const response = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    if (!response.data.id || !response.data.threadId) {
      throw new Error("Invalid message response from Gmail API");
    }

    return {
      id: response.data.id,
      threadId: response.data.threadId,
      labelIds: response.data.labelIds || [],
      snippet: response.data.snippet || "",
      payload: response.data.payload as GmailMessagePart | undefined,
      internalDate: response.data.internalDate,
      sizeEstimate: response.data.sizeEstimate || 0,
      historyId: response.data.historyId,
    };
  }

  private htmlToText(html: string): string {
    if (!html) return "";

    // First, try to extract text content from common email structures
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const content = bodyMatch ? bodyMatch[1] : html;

    // Remove script and style tags
    let text = content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

    // Replace common HTML elements with newlines for better readability
    text = text
      .replace(/<\/?(div|p|br|hr|h\d|article|section)[^>]*>/gi, "\n")
      .replace(/<\/?(li|dt|dd)[^>]*>/gi, "\n• ")
      .replace(/<\/td>/gi, " ")
      .replace(/<\/tr>/gi, "\n");

    // Remove remaining HTML tags
    text = text.replace(/<[^>]+>/g, " ");

    // Handle HTML entities and whitespace
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&[a-z0-9]+;/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    return text;
  }

  private getPartData(
    part: GmailMessagePart
  ): { type: string; data: string } | null {
    if (part.body?.data) {
      return {
        type: part.mimeType || "text/plain",
        data: Buffer.from(part.body.data, "base64").toString("utf-8"),
      };
    }
    return null;
  }

  private async processPart(
    part: GmailMessagePart,
    textParts: string[],
    htmlParts: string[]
  ): Promise<void> {
    // Check if this part has data
    const partData = this.getPartData(part);
    if (partData) {
      if (partData.type === "text/plain") {
        textParts.push(partData.data);
      } else if (partData.type === "text/html") {
        htmlParts.push(partData.data);
      }
    }

    // Process nested parts
    if (part.parts) {
      for (const subPart of part.parts) {
        await this.processPart(subPart, textParts, htmlParts);
      }
    }
  }

  async getMessageBody(message: GmailMessage): Promise<string> {
    if (!message.payload) return "";

    const textParts: string[] = [];
    const htmlParts: string[] = [];

    // Process the message parts
    await this.processPart(message.payload, textParts, htmlParts);

    // Try to get the subject for better context
    const headers = message.payload.headers || [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";

    // Combine all text parts
    const combinedText = textParts.join("\n\n").trim();
    const combinedHtml = htmlParts.join("\n\n").trim();

    // If we have plain text, use that first
    if (combinedText) {
      return combinedText;
    }

    // Otherwise, try to extract text from HTML
    if (combinedHtml) {
      return this.htmlToText(combinedHtml);
    }

    // Fallback to the body data if no parts
    if (message.payload.body?.data) {
      try {
        return Buffer.from(message.payload.body.data, "base64").toString(
          "utf-8"
        );
      } catch (error) {
        console.error("Error decoding message body:", error);
      }
    }

    // If we still don't have content, return the subject as a last resort
    return subject;
  }

  private async getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<{ data: string | null; size: number } | null> {
    const gmail = await this.getGmailClient();

    try {
      const response = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });

      return {
        data: response.data.data || null,
        size: response.data.size || 0,
      };
    } catch (error) {
      console.error(`Error getting attachment ${attachmentId}:`, error);
      return null;
    }
  }

  async getAttachments(message: GmailMessage): Promise<GmailAttachment[]> {
    if (!message.payload?.parts) return [];

    const attachments: GmailAttachment[] = [];
    const parts: GmailMessagePart[] = [message.payload];

    // Process all parts recursively
    while (parts.length > 0) {
      const part = parts.pop();
      if (!part) continue;

      // Add any nested parts to the queue
      if (part.parts) {
        parts.push(...part.parts);
      }

      // Check if this part is an attachment
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        try {
          const attachment = await this.getAttachment(message.id, part.body.attachmentId);
          if (!attachment?.data) {
            console.log(`No data for attachment: ${part.filename}`);
            continue;
          }

          const mimeType = (part.mimeType || "").toLowerCase();
          const filename = part.filename.toLowerCase();

          // Check if file is a PDF by MIME type or extension
          const isPdf = mimeType === "application/pdf" || filename.endsWith(".pdf");

          // Check if file has a supported extension
          const hasSupportedExtension = [
            ".pdf",
            ".txt",
            ".doc",
            ".docx",
            ".xls",
            ".xlsx",
            ".jpg",
            ".jpeg",
            ".png",
          ].some((ext) => filename.endsWith(ext));

          // Check if MIME type is in our supported list
          const supportedMimeTypes = [
            "application/pdf",
            "text/plain",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "image/jpeg",
            "image/png",
          ];
          
          const isSupportedMimeType = supportedMimeTypes.some(
            (type) => mimeType.startsWith(type)
          );

          // Accept the file if it's explicitly a PDF or has a supported MIME type/extension
          const shouldAcceptFile = isPdf || isSupportedMimeType || hasSupportedExtension;

          if (!shouldAcceptFile) {
            console.log(
              `Skipping unsupported file: ${part.filename} (${mimeType})`
            );
            continue;
          }

          // At this point, we know attachment.data is not null due to earlier check

          attachments.push({
            filename: part.filename,
            mimeType: mimeType,
            data: attachment.data,
            size: attachment.size,
          });
        } catch (error) {
          console.error(`Error processing attachment ${part.filename}:`, error);
          continue;
        }
      }
    }

    return attachments;
  }

  async markAsProcessed(messageId: string) {
    const gmail = await this.getGmailClient();
    const labelName = "INVOICE_PROCESSED";

    try {
      // First, try to create the label if it doesn't exist
      let labelId: string | undefined;

      try {
        const labelsRes = await gmail.users.labels.list({ userId: "me" });
        const existingLabel = labelsRes.data.labels?.find(
          (label) => label.name === labelName
        );

        if (!existingLabel) {
          const createRes = await gmail.users.labels.create({
            userId: "me",
            requestBody: {
              name: labelName,
              labelListVisibility: "labelShow",
              messageListVisibility: "show",
            },
          });
          labelId = createRes.data.id!;
        } else {
          labelId = existingLabel.id!;
        }
      } catch (error) {
        console.warn("Failed to create label, proceeding without it:", error);
      }

      // Now modify the message with the label
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
          addLabelIds: labelId ? [labelId] : [],
        },
      });
    } catch (error) {
      console.error("Error in markAsProcessed:", error);
      throw error;
    }
  }
}
