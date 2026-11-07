import { invoke, isTauri } from '@tauri-apps/api/core';
export type XIdentity = { id: string; username: string; name: string };
export type XPost = { id: string; text: string };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to connect X.'); }
export async function xConnection(): Promise<XIdentity | null> { desktopOnly(); return invoke('x_connection'); }
export async function connectX(clientId: string): Promise<XIdentity> { desktopOnly(); return invoke('connect_x', { clientId }); }
export async function disconnectX(): Promise<void> { desktopOnly(); return invoke('disconnect_x'); }
export async function postToX(text: string): Promise<XPost> { desktopOnly(); return invoke('post_to_x', { text }); }
