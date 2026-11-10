import { useState } from 'react';
import InstagramPublisher from './InstagramPublisher';
import XPublisher from './XPublisher';
import { getPlatform, type Account, type Brand, type Platform } from './model';

/** Picks which live profile to post as; each profile posts through its own connection. */
function Picker({ platform, profiles, brands, value, onChange }: { platform: Platform; profiles: Account[]; brands: Brand[]; value: string; onChange: (id: string) => void }) {
  if (profiles.length === 0) return null;
  const name = (account: Account) => brands.find((brand) => brand.id === account.brandId)?.name ?? account.label;
  return <label className="connection-pick">Post to {getPlatform(platform).name} as <select value={value} onChange={(event) => onChange(event.target.value)}>
    {profiles.map((account) => <option key={account.id} value={account.id}>{name(account)} (@{account.handle})</option>)}
  </select></label>;
}

/** The X and Instagram publishers, each tied to the chosen profile's own connection. */
export default function PostAs({ accounts, brands }: { accounts: Account[]; brands: Brand[] }) {
  const live = (platform: Platform) => accounts.filter((account) => account.platform === platform && account.status === 'active');
  const xProfiles = live('x');
  const igProfiles = live('instagram');
  const [xId, setXId] = useState('');
  const [igId, setIgId] = useState('');
  const x = xProfiles.find((account) => account.id === xId) ?? xProfiles[0];
  const ig = igProfiles.find((account) => account.id === igId) ?? igProfiles[0];
  return <>
    <Picker platform="x" profiles={xProfiles} brands={brands} value={x?.id ?? ''} onChange={setXId}/>
    <XPublisher key={`x-${x?.id ?? 'shared'}`} profile={x?.id}/>
    <Picker platform="instagram" profiles={igProfiles} brands={brands} value={ig?.id ?? ''} onChange={setIgId}/>
    <InstagramPublisher key={`ig-${ig?.id ?? 'shared'}`} profile={ig?.id}/>
  </>;
}
