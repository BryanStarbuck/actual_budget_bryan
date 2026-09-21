import { useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import { errorFileFor } from '@actual-app/error-file';

import { useSyncServerStatus } from './useSyncServerStatus';

const errors = errorFileFor(
  'desktop-client/src/hooks/useEnableBankingStatus.ts',
);

export function useEnableBankingStatus(enabled = true) {
  const [configuredEnableBanking, setConfiguredEnableBanking] = useState<
    boolean | null
  >(null);
  const [isLoading, setIsLoading] = useState(true);
  const status = useSyncServerStatus();

  useEffect(() => {
    if (!enabled) return;

    async function fetch() {
      setIsLoading(true);
      try {
        const results = await send('enablebanking-status');
        setConfiguredEnableBanking(results.configured || false);
      } catch (e) {
        errors.expected('probing the Enable Banking configuration', e);
        setConfiguredEnableBanking(false);
      } finally {
        setIsLoading(false);
      }
    }

    if (status === 'online') {
      void fetch();
    }
  }, [status, enabled]);

  return {
    configuredEnableBanking,
    isLoading,
  };
}
