// @ts-strict-ignore
import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Block } from '@actual-app/components/block';
import { ButtonWithLoading } from '@actual-app/components/button';
import { Paragraph } from '@actual-app/components/paragraph';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { errorFileFor } from '@actual-app/error-file';

import { importBudget } from '#budgetfiles/budgetfilesSlice';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { ImportProgress } from '#components/modals/manager/ImportProgress';
import { useNavigate } from '#hooks/useNavigate';
import { useDispatch } from '#redux';

const errors = errorFileFor(
  'desktop-client/src/components/modals/manager/ImportYNAB4Modal.tsx',
);

// Import failures the user can fix by picking a different file (R7).
const USER_FIXABLE_IMPORT_ERRORS = new Set(['not-ynab4']);

function getErrorMessage(error: string): string {
  switch (error) {
    case 'not-ynab4':
      return 'This file is not valid. Please select a compressed ynab4 zip file.';
    default:
      return 'An unknown error occurred while importing. Please report this as a new issue on GitHub.';
  }
}

export function ImportYNAB4Modal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function onImport() {
    const res = await window.Actual.openFileDialog({
      properties: ['openFile'],
      filters: [{ name: 'ynab', extensions: ['zip'] }],
    });
    if (res) {
      setImporting(true);
      setError(null);
      try {
        await dispatch(importBudget({ filepath: res[0], type: 'ynab4' }));
        void navigate('/budget');
      } catch (err) {
        if (USER_FIXABLE_IMPORT_ERRORS.has(err.message)) {
          errors.expected('importing a YNAB4 budget', err);
        } else {
          errors.caught('importing a YNAB4 budget', err);
        }
        setError(err.message);
      } finally {
        setImporting(false);
      }
    }
  }

  return (
    <Modal
      name="import-ynab4"
      isDismissable={!importing}
      containerProps={{ style: { width: 400 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Import from YNAB4')}
            rightContent={
              !importing && <ModalCloseButton onPress={() => state.close()} />
            }
          />
          <View style={{ ...styles.smallText, lineHeight: 1.5, marginTop: 20 }}>
            {error && (
              <Block style={{ color: theme.errorText, marginBottom: 15 }}>
                {getErrorMessage(error)}
              </Block>
            )}

            <View style={{ alignItems: 'center' }}>
              <Paragraph>
                <Trans>
                  To import data from YNAB4, locate where your YNAB4 data is
                  stored. It is usually in your Documents folder under YNAB.
                  Your data is a directory inside that with the
                  <code>.ynab4</code> suffix.
                </Trans>
              </Paragraph>
              <Paragraph>
                <Trans>
                  When you've located your data,{' '}
                  <strong>compress it into a zip file</strong>. On macOS,
                  right-click the folder and select "Compress". On Windows,
                  right-click and select "Send to &rarr; Compressed (zipped)
                  folder". Upload the zipped folder for importing.
                </Trans>
              </Paragraph>
              {!importing && (
                <View>
                  <ButtonWithLoading
                    variant="primary"
                    autoFocus
                    onPress={onImport}
                  >
                    <Trans>Select zip file...</Trans>
                  </ButtonWithLoading>
                </View>
              )}
              <ImportProgress />
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}
