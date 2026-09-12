import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { findCodexHistoryMessagesDuplicatedByLiveMessage } from "@t3tools/shared/codexMessageReconciliation";

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: QueuedThreadMessage;
  readonly acknowledged?: boolean;
};

/** Append the outbox after all presented activity, until the server echoes each message. */
export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0) return presentedFeed;
  const deliveredMessages = feed.flatMap((entry) =>
    entry.type === "message"
      ? [
          {
            messageId: String(entry.message.id),
            role: entry.message.role,
            text: entry.message.text,
            createdAt: entry.message.createdAt,
            turnId: entry.message.turnId,
          },
        ]
      : [],
  );
  const deliveredIds = new Set(deliveredMessages.map((message) => message.messageId));
  return [
    ...presentedFeed,
    ...queuedMessages
      .filter(
        (message) =>
          !deliveredIds.has(message.messageId) &&
          findCodexHistoryMessagesDuplicatedByLiveMessage(
            {
              messageId: String(message.messageId),
              role: "user",
              text: message.text,
              createdAt: message.createdAt,
              turnId: null,
            },
            deliveredMessages,
          ).length === 0,
      )
      .map((pendingMessage): PendingThreadFeedEntry => ({
        type: "message",
        id: pendingMessage.messageId,
        createdAt: pendingMessage.createdAt,
        pendingMessage,
        message: {
          id: pendingMessage.messageId,
          role: "user",
          text: pendingMessage.text,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          turnId: null,
          streaming: false,
        },
      })),
  ];
}
