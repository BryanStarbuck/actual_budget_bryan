import { useEffect, useState } from 'react';

import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { errorFileFor } from '@actual-app/error-file';

import { locationService } from '#payees/location';

const errors = errorFileFor(
  'desktop-client/src/hooks/useLocationPermission.ts',
);

export type LocationPermission = {
  isGranted: boolean;
  isPending: boolean;
  requestPermission: () => Promise<void>;
};

/**
 * Custom hook to manage geolocation permission status.
 *
 * Payee location functionality is only available on the mobile transaction
 * screen, so permission is only tracked at narrow widths.
 *
 * @returns a LocationPermissions object
 */
export function useLocationPermission(): LocationPermission {
  const { isNarrowWidth } = useResponsive();
  const [state, setState] = useState<PermissionState | null>(null);

  useEffect(() => {
    if (!isNarrowWidth) {
      setState(null);
      return;
    }

    let permissionStatus: PermissionStatus | null = null;
    let handleChange: (() => void) | null = null;
    let isMounted = true;

    // Check if Permissions API is available
    if (
      !navigator.permissions ||
      typeof navigator.permissions.query !== 'function'
    ) {
      setState(null);
      return;
    }

    try {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then(status => {
          if (!isMounted) {
            return;
          }

          permissionStatus = status;
          // Set initial state
          setState(status.state);

          // Listen for permission changes
          handleChange = () => {
            setState(status.state);
          };

          status.addEventListener('change', handleChange);
        })
        .catch(e => {
          // Permission API not supported, assume no access
          errors.expected('querying the geolocation permission', e);
          if (!isMounted) {
            return;
          }
          setState(null);
        });
    } catch (e) {
      // Synchronous error (e.g., TypeError), assume no access
      errors.expected('querying the geolocation permission', e);
      if (!isMounted) {
        return;
      }
      setState(null);
    }

    // Cleanup function
    return () => {
      isMounted = false;
      if (permissionStatus && handleChange) {
        permissionStatus.removeEventListener('change', handleChange);
      }
    };
  }, [isNarrowWidth]);

  const requestPermission = async () => {
    try {
      await locationService.getCurrentPosition();
      setState('granted');
    } catch (e) {
      // The user declined, or the device has no location: an answer, not a fault
      errors.expected('requesting the current position', e);
      // Re-query permissions state just in case
      try {
        const status = await navigator.permissions.query({
          name: 'geolocation',
        });
        setState(status.state);
      } catch (queryError) {
        errors.expected('re-querying the geolocation permission', queryError);
        setState('denied');
      }
    }
  };

  return {
    isGranted: state === 'granted',
    isPending: state === 'prompt',
    requestPermission,
  };
}
