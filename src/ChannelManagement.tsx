import { useState, type FormEvent } from 'react';
import { AppWindow, ChevronRight, Plus, X } from 'lucide-react';
import { makeChannel, type Channel } from './channelModel';
import { getPlatform, PLATFORMS, type Platform, type PlatformAction, type Workspace } from './model';
import './channel.css';

type Save = (next: Workspace, success: string) => Promise<boolean | undefined>;
type Open = (platform: Platform, action: PlatformAction) => Promise<void>;

type Props = { workspace: Workspace; busy: boolean; loaded: boolean; onSave: Save; onOpen: Open };

function ChannelMark({ platform }: { platform: Platform }) {
  const item = getPlatform(platform);
  return <span aria-hidden="true" className={`platform-mark ${platform}`}>{item.mark}</span>;
}

export default function ChannelManagement({ workspace, busy, loaded, onSave, onOpen }: Props) {
  const [editing, setEditing] = useState<Channel | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<Platform | 'all'>('all');
  const [saving, setSaving] = useState(false);
  const channels = workspace.channels ?? [];
  const shown = filter === 'all' ? channels : channels.filter((channel) => channel.platform === filter);

  async function save(channel: Channel) {
    if (saving || busy || !loaded) return;
    setSaving(true);
    try {
      const exists = channels.some((item) => item.id === channel.id);
      const updated = exists ? channels.map((item) => item.id === channel.id ? channel : item) : [...channels, channel];
      if (await onSave({ ...workspace, channels: updated }, exists ? 'Channel details saved.' : 'Channel added to your workspace.')) { setShowForm(false); setEditing(null); }
    } finally { setSaving(false); }
  }
  async function remove(channel: Channel) {
    if (saving || busy || !loaded || !window.confirm(`Remove ${channel.name} from this workspace? This will not delete the channel on ${getPlatform(channel.platform).name}.`)) return;
    setSaving(true);
    try { if (await onSave({ ...workspace, channels: channels.filter((item) => item.id !== channel.id) }, 'Channel removed from this workspace.')) { setShowForm(false); setEditing(null); } }
    finally { setSaving(false); }
  }
  const disabled = busy || saving || !loaded;
  const openForm = (channel: Channel | null) => { setEditing(channel); setShowForm(true); };
  return <>
    <div className="page-heading"><div><p className="greeting">Your presence, organized</p><h1>Channels</h1><p>Keep a directory of the places where your business publishes.</p></div><button className="primary-button" disabled={disabled} onClick={() => openForm(null)}><Plus size={18}/> Add a channel</button></div>
    <div className="info-banner"><AppWindow size={19}/><span>Saved channels are local references. To create, sign in to, or change a channel on a platform, open that platform below.</span></div>
    <div className="channel-filters" role="group" aria-label="Filter channels by platform"><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <span>{channels.length}</span></button>{PLATFORMS.map((platform) => <button type="button" aria-pressed={filter === platform.id} key={platform.id} onClick={() => setFilter(platform.id)}>{platform.name} <span>{channels.filter((channel) => channel.platform === platform.id).length}</span></button>)}</div>
    <div className="channel-list">{shown.length ? shown.map((channel) => {
      const account = workspace.accounts.find((item) => item.id === channel.accountId && item.platform === channel.platform);
      return <article className="channel-list-row" key={channel.id}><ChannelMark platform={channel.platform}/><div className="channel-list-details"><strong>{channel.name}</strong><span>{getPlatform(channel.platform).name}{channel.handle ? ` · @${channel.handle}` : ''}{account ? ` · ${account.label}` : channel.accountId ? ' · Account removed' : ''}</span>{channel.notes && <p>{channel.notes}</p>}</div><button className="outline-button" disabled={disabled} onClick={() => openForm(channel)}>Edit<span className="sr-only"> {channel.name}</span></button><button className="channel-manage" disabled={busy || saving} onClick={() => void onOpen(channel.platform, 'manage')}>Open {getPlatform(channel.platform).name} <AppWindow size={14}/></button></article>;
    }) : <div className="channel-empty"><strong>{filter === 'all' ? 'No channels added yet' : `No ${getPlatform(filter).name} channels added`}</strong><p>Add a reference to a channel you already have, or open a platform to create one.</p><button className="primary-button" disabled={disabled} onClick={() => openForm(null)}><Plus size={16}/> Add a channel</button></div>}</div>
    <div className="channel-platform-heading"><h2>Platform tools</h2><p>Open a platform inside the app to create or manage your presence.</p></div><div className="channel-platform-grid">{PLATFORMS.map((platform) => <div className="channel-platform" key={platform.id}><ChannelMark platform={platform.id}/><div><strong>{platform.name}</strong><span>{channels.filter((channel) => channel.platform === platform.id).length} saved</span></div><button disabled={busy || saving} onClick={() => void onOpen(platform.id, 'create')}>{platform.id === 'youtube' ? 'Create channel' : 'Create account'} <AppWindow size={14}/></button></div>)}</div>
    {showForm && <ChannelForm channel={editing} accounts={workspace.accounts} busy={disabled} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} onRemove={remove}/>}
  </>;
}

function ChannelForm({ channel, accounts, busy, onClose, onSave, onRemove }: { channel: Channel | null; accounts: Workspace['accounts']; busy: boolean; onClose: () => void; onSave: (channel: Channel) => Promise<void>; onRemove: (channel: Channel) => Promise<void> }) {
  const [platform, setPlatform] = useState<Platform>(channel?.platform ?? 'youtube');
  const [name, setName] = useState(channel?.name ?? '');
  const [handle, setHandle] = useState(channel?.handle ?? '');
  const [accountId, setAccountId] = useState(channel?.accountId ?? '');
  const [notes, setNotes] = useState(channel?.notes ?? '');
  const matchingAccounts = accounts.filter((account) => account.platform === platform);
  const accountMissing = Boolean(accountId) && !matchingAccounts.some((account) => account.id === accountId);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    const result = makeChannel(platform, name, handle, accountId || null, notes);
    void onSave(channel ? { ...result, id: channel.id } : result);
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="channel-title"><div className="dialog-header"><div><p className="greeting">Your channel directory</p><h2 id="channel-title">{channel ? 'Edit channel' : 'Add a channel'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><X size={20}/></button></div><p className="dialog-copy">Save a reference to a channel. This does not create it or sign you in.</p><form onSubmit={submit}>
    <label htmlFor="channel-platform">Platform</label><select id="channel-platform" value={platform} onChange={(event) => { setPlatform(event.target.value as Platform); setAccountId(''); }}>{PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    <label htmlFor="channel-name">Channel name</label><input id="channel-name" autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Your business channel"/>
    <label htmlFor="channel-handle">Handle <span>optional</span></label><input id="channel-handle" maxLength={120} value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@yourbusiness"/>
    <label htmlFor="channel-account">Related account <span>optional</span></label><select id="channel-account" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">No account selected</option>{accountMissing && <option value={accountId}>Account removed</option>}{matchingAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}{account.handle ? ` (@${account.handle})` : ''}</option>)}</select>
    <label htmlFor="channel-notes">Notes <span>optional</span></label><textarea id="channel-notes" maxLength={1000} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes (do not enter passwords or API keys)"/>
    <div className="dialog-actions">{channel && <button className="remove-button" type="button" disabled={busy} onClick={() => void onRemove(channel)}>Remove</button>}<button className="outline-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !name.trim()}>{channel ? 'Save changes' : 'Add channel'}</button></div>
  </form></section></div>;
}

export function ChannelOverview({ workspace, onView }: { workspace: Workspace; onView: () => void }) {
  const channels = workspace.channels ?? [];
  return <section className="channel-overview"><div className="section-heading"><div><h2>Channels</h2><p>Your saved publishing destinations.</p></div><button className="text-button" onClick={onView}>Manage channels <ChevronRight size={16}/></button></div><div className="channel-overview-stats"><strong>{channels.length.toString().padStart(2, '0')}</strong><span>{channels.length === 1 ? 'channel saved' : 'channels saved'}</span><div className="channel-overview-platforms">{PLATFORMS.map((platform) => { const count = channels.filter((channel) => channel.platform === platform.id).length; return <div key={platform.id}><span className={`channel-mini-mark ${platform.id}`}>{platform.mark}</span><span>{platform.name}</span><strong>{count}</strong></div>; })}</div></div></section>;
}
