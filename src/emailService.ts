import { invoke, isTauri } from '@tauri-apps/api/core';

export type EmailConnection = { host: string; username: string };
export type EmailSummary = { uid: number; from: string; subject: string; date: string; unread: boolean };
export type EmailMessage = { uid: number; from: string; to: string; subject: string; date: string; body: string };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use email.'); }
export async function emailConnection(): Promise<EmailConnection | null> { desktopOnly(); return invoke('email_connection'); }
export async function connectEmail(host: string, port: number, username: string, password: string): Promise<EmailConnection> { desktopOnly(); return invoke('connect_email', { host, port, username, password }); }
export async function disconnectEmail(): Promise<void> { desktopOnly(); return invoke('disconnect_email'); }
export async function listEmails(options: { limit?: number; unreadOnly?: boolean; search?: string }): Promise<EmailSummary[]> { desktopOnly(); return invoke('list_emails', { limit: options.limit ?? null, unreadOnly: options.unreadOnly ?? null, search: options.search ?? null }); }
export async function readEmail(uid: number): Promise<EmailMessage> { desktopOnly(); return invoke('read_email', { uid }); }
