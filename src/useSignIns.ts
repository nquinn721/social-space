import { useEffect, useState } from 'react';
import { onSignInChange, postingSignIns, type SignIns } from './postingService';

/** Every brand's window sign-ins on this PC, kept current while a brand window checks them. */
export function useSignIns(): SignIns {
  const [signIns, setSignIns] = useState<SignIns>({});
  useEffect(() => {
    let live = true;
    const load = () => { postingSignIns().then((next) => { if (live) setSignIns(next); }).catch(() => undefined); };
    load();
    let stop: (() => void) | undefined;
    void onSignInChange(load).then((unlisten) => { if (live) stop = unlisten; else unlisten(); });
    return () => { live = false; stop?.(); };
  }, []);
  return signIns;
}
