import { invoke, isTauri } from '@tauri-apps/api/core';
export type XIdentity = { id: string; username: string; name: string };
export type XPost = { id: string; text: string };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to connect X.'); }
export async function xConnection(profile?: string): Promise<XIdentity | null> { desktopOnly(); return invoke('x_connection', { profile: profile ?? null }); }
export async function claimXConnection(profile: string, username: string): Promise<XIdentity | null> { desktopOnly(); return invoke('claim_x_connection', { profile, username }); }
/** clientId can be left empty once the X developer app is saved. Rejects with SETUP_NEEDED when neither is there. */
export async function connectX(clientId: string, profile?: string): Promise<XIdentity> { desktopOnly(); return invoke('connect_x', { clientId: clientId || null, profile: profile ?? null }); }
export async function disconnectX(profile?: string): Promise<void> { desktopOnly(); return invoke('disconnect_x', { profile: profile ?? null }); }
export async function postToX(text: string, profile?: string): Promise<XPost> { desktopOnly(); return invoke('post_to_x', { text, profile: profile ?? null }); }
