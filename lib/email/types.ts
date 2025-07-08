// Shared types for email-related functionality

export type GmailHeader = {
  name: string;
  value: string;
};

export type GmailPayloadBody = {
  data?: string | null;
  size?: number | null;
  attachmentId?: string | null;
};

export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailPayloadBody;
  parts?: GmailMessagePart[];
};

export type GmailPayload = {
  headers?: GmailHeader[];
  parts?: GmailMessagePart[];
  body?: GmailPayloadBody;
};

export type GmailMessage = {
  id: string;
  threadId: string;
  payload?: GmailPayload | null;
  internalDate?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  sizeEstimate?: number | null;
  historyId?: string | null;
};

export type GmailMessageListResponse = {
  messages: Array<{
    id: string;
    threadId: string;
  }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
};

// Type guard to check if a message has the required id and threadId
export function isValidGmailMessage(
  message: Partial<GmailMessage>,
): message is GmailMessage {
  return !!(message.id && message.threadId);
}

export type GmailAttachment = {
  filename: string;
  mimeType: string;
  data: string;
  size: number;
};
