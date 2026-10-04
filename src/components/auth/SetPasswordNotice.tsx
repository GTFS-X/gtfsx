import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Banner } from '../ui/Banner';
import { useStore } from '../../store';
import {
  SET_PASSWORD_HREF,
  SET_PASSWORD_NOTICE_PARAM,
  SET_PASSWORD_NOTICE_TEXT,
  showSetPasswordNotice,
} from './passwordNoticeHelpers';

/**
 * Notice on the post-verify landing page when the signup password was
 * discarded because the verify link was opened in a different browser.
 */
export function SetPasswordNotice({ className = '' }: { className?: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const hasPassword = useStore((s) => s.currentUser?.hasPassword);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !showSetPasswordNotice(searchParams, hasPassword)) return null;

  const handleDismiss = () => {
    setDismissed(true);
    const next = new URLSearchParams(searchParams);
    next.delete(SET_PASSWORD_NOTICE_PARAM);
    setSearchParams(next, { replace: true });
  };

  return (
    <Banner
      variant="warning"
      onDismiss={handleDismiss}
      className={className}
      actions={
        <Link to={SET_PASSWORD_HREF} className="font-semibold underline whitespace-nowrap">
          Set a password
        </Link>
      }
    >
      {SET_PASSWORD_NOTICE_TEXT}
    </Banner>
  );
}
