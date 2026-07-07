import { getDb } from '../../db/connection';
import type { UIMessage } from 'ai';

/**
 * Saves a single chat message to a specific thread in the database.
 */
export function saveChatMessage(
  workspaceId: string,
  threadId: string,
  threadTitle: string,
  messageId: string,
  role: 'user' | 'assistant',
  message: UIMessage
): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Clean up any message with the same ID first to avoid duplicate insertions
  db.run('DELETE FROM store_manager_chat_history WHERE id = ?', [messageId]);

  db.run(
    `INSERT INTO store_manager_chat_history (id, workspace_id, thread_id, thread_title, role, message_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [messageId, workspaceId, threadId, threadTitle, role, JSON.stringify(message), now]
  );
}

/**
 * Retrieves the list of active chat threads for the last 7 days.
 */
export function getChatThreads(workspaceId: string): { id: string; title: string; createdAt: string }[] {
  const db = getDb();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.query(
    `SELECT thread_id, thread_title, MIN(created_at) as first_msg_at 
     FROM store_manager_chat_history 
     WHERE workspace_id = ? AND created_at >= ? AND thread_id IS NOT NULL
     GROUP BY thread_id 
     ORDER BY first_msg_at DESC`
  ).all(workspaceId, oneWeekAgo) as { thread_id: string; thread_title: string; first_msg_at: string }[];

  return rows.map(r => ({
    id: r.thread_id,
    title: r.thread_title || 'Untitled Conversation',
    createdAt: r.first_msg_at,
  }));
}

/**
 * Retrieves the full chat history for a specific thread.
 */
export function getChatHistory(workspaceId: string, threadId: string): UIMessage[] {
  const db = getDb();
  const rows = db.query(
    `SELECT message_json FROM store_manager_chat_history 
     WHERE workspace_id = ? AND thread_id = ? 
     ORDER BY created_at ASC`
  ).all(workspaceId, threadId) as { message_json: string }[];

  return rows.map(r => JSON.parse(r.message_json));
}

/**
 * Clears chat history for a specific thread.
 */
export function clearChatHistory(workspaceId: string, threadId: string): void {
  const db = getDb();
  db.run('DELETE FROM store_manager_chat_history WHERE workspace_id = ? AND thread_id = ?', [workspaceId, threadId]);
}

/**
 * Prunes messages older than 7 days (1 week).
 */
export function pruneOldChatHistory(): void {
  const db = getDb();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.run('DELETE FROM store_manager_chat_history WHERE created_at < ?', [oneWeekAgo]);
}
