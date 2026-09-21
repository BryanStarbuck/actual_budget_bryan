import React from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useTranslation } from 'react-i18next';

import { errorFileFor, reportBoundaryError } from '@actual-app/error-file';

import { FeatureErrorFallback } from '#components/FeatureErrorFallback';

import { ManageRules } from './ManageRules';
import { Page } from './Page';

const errors = errorFileFor(
  'desktop-client/src/components/ManageRulesPage.tsx',
);
const reportRenderError = reportBoundaryError(
  errors,
  'rendering the rules page',
);

export function ManageRulesPage() {
  const { t } = useTranslation();
  return (
    <ErrorBoundary
      onError={reportRenderError}
      FallbackComponent={FeatureErrorFallback}
    >
      <Page header={t('Rules')}>
        <ManageRules isModal={false} payeeId={null} />
      </Page>
    </ErrorBoundary>
  );
}
