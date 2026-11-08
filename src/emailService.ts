import { invoke, isTauri } from '@tauri-apps/api/core';

/** kind: 'imap' uses an app password; 'gmail' reads through the Gmail sign-in inside the app. */
export type EmailConnection = { host: string; username: string; kind?: 'imap' | 'gmail' };
export type EmailSummary = { uid: number; from: string; subject: string; date: string; unread: boolean };
export type EmailMessage = { uid: number; from: string; to: string; subject: string; date: string; body: string };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use email.'); }
export async function emailConnection(): Promise<EmailConnection | null> { desktopOnly(); return invoke('email_connection'); }
export async function connectEmail(host: string, port: number, username: string, password: string): Promise<EmailConnection> { desktopOnly(); return invoke('connect_email', { host, port, username, password }); }
export async function disconnectEmail(): Promise<void> { desktopOnly(); return invoke('disconnect_email'); }
export async function listEmails(options: { limit?: number; unreadOnly?: boolean; search?: string }): Promise<EmailSummary[]> { desktopOnly(); return invoke('list_emails', { limit: options.limit ?? null, unreadOnly: options.unreadOnly ?? null, search: options.search ?? null }); }
export async function readEmail(uid: number): Promise<EmailMessage> { desktopOnly(); return invoke('read_email', { uid }); }
/** Opens Gmail's sign-in page in an app window; the sign-in stays saved in the app. */
export async function openGmailSignIn(): Promise<void> { desktopOnly(); return invoke('open_gmail_sign_in'); }
/** Checks the in-app Gmail sign-in and switches the inbox to it. */
export async function connectGmailSession(): Promise<EmailConnection> { desktopOnly(); return invoke('connect_gmail_session'); }
export async function openGmailMessage(uid: number): Promise<void> { desktopOnly(); return invoke('open_gmail_message', { uid }); }
