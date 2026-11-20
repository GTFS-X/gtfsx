import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Button } from '../ui/Button';
import { RailSubHeading } from '../ui/RailHeadings';
import { TranslationsEditor } from '../translations/EntityTranslations';
import { LanguagePicker } from '../translations/LanguagePicker';
import { TABLE_SPEC } from '../../services/translations';
import {
  GTFSX_PUBLISHER_NAME, gtfsDateToIso, isoToGtfsDate, isValidGtfsDate, nextFeedVersion, serviceDateRange, validateFeedInfo,
  type FeedInfoField,
} from '../../services/feedInfo';
import { applyServiceDatesToFeedInfo } from '../../services/validationFixes';
import type { FeedInfo } from '../../types/gtfs';

const FEED_INFO_FIELDS = TABLE_SPEC.feed_info.translatable.filter((f) => f.common);

const prettyDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/**
 * Agency → Feed Info: every feed_info.txt field, written to the export exactly
 * as entered (gtfsExport buildFeedInfoRow). A feed with no feed_info gets one
 * on the first edit. Edits go through the store's undo history like any other
 * feed change.
 *
 * Publisher: fixed to GTFS·X on every export and publish (product decision
 * 2026-06-22, gtfsExport buildFeedInfoRow). The prior/imported publisher is
 * shown read-only for reference but never written to feed_info.txt.
 */
export function FeedInfoEditor({ agencyLang }: { agencyLang?: string }) {
  const feedInfo = useStore((s) => s.feedInfo);
  const updateFeedInfo = useStore((s) => s.updateFeedInfo);
  const calendars = useStore((s) => s.calendars);
  const calendarDates = useStore((s) => s.calendarDates);

  const range = serviceDateRange(calendars, calendarDates);
  const issues = validateFeedInfo(feedInfo);
  const errorFor = (field: FeedInfoField) => issues.find((i) => i.field === field)?.message;

  // Blank optional fields are stored as absent, not '', so they stay out of
  // the exported row and the "changed" checks.
  const set = (field: keyof FeedInfo) => (v: string) => updateFeedInfo({ [field]: v === '' ? undefined : v });

  const datesMatch = range !== null
    && feedInfo?.feed_start_date === range.start && feedInfo?.feed_end_date === range.end;

  return (
    <div data-testid="feed-info-editor">
      <RailSubHeading>Feed Info</RailSubHeading>
      <p className="text-[11px] text-warm-gray -mt-1 mb-3 leading-snug">
        Written to feed_info.txt on every export and publish. Apps use the dates to decide whether the
        feed is current.
      </p>

      {/* ── Publisher (read-only; always GTFS·X on export) ──────── */}
      <FormField
        label="Prior publisher"
        value={feedInfo?.feed_publisher_name || ''}
        onChange={() => {}}
        disabled
        placeholder={`None (published as ${GTFSX_PUBLISHER_NAME})`}
      />
      <FormField
        label="Prior publisher URL"
        value={feedInfo?.feed_publisher_url || ''}
        onChange={() => {}}
        disabled
        placeholder={`None (published as ${GTFSX_PUBLISHER_NAME})`}
      />

      {/* ── Languages ─────────────────────────────────────────────── */}
      {/* feed_lang: the language the feed's original text is in. Shown as the
          actual stored value (blank = unset; the exporter then falls back to
          the agency language) so the translations rules can be read off it. */}
      <FormField label="Feed Language" testId="field-feed-language" error={errorFor('feed_lang')}>
        <LanguagePicker
          value={feedInfo?.feed_lang ?? ''}
          onChange={(v) => updateFeedInfo({ feed_lang: v })}
          allowMultilingual
          placeholder={`Not set (exports as ${agencyLang || 'en'})`}
          ariaLabel="Feed language"
          testId="feed-lang-input"
        />
      </FormField>
      <FormField label="Default Language" testId="field-default-language" error={errorFor('default_lang')}>
        <LanguagePicker
          value={feedInfo?.default_lang ?? ''}
          onChange={(v) => updateFeedInfo({ default_lang: v || undefined })}
          placeholder="Optional (e.g. en)"
          ariaLabel="Default language"
          testId="default-lang-input"
        />
        <p className="text-[11px] text-warm-gray mt-1">
          The language apps show when they don&rsquo;t know the rider&rsquo;s. Usually your main language.
        </p>
      </FormField>

      {/* ── Dates ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <DateField
          label="Feed Start Date"
          testId="feed-start-date"
          value={feedInfo?.feed_start_date}
          error={errorFor('feed_start_date')}
          onChange={set('feed_start_date')}
        />
        <DateField
          label="Feed End Date"
          testId="feed-end-date"
          value={feedInfo?.feed_end_date}
          error={errorFor('feed_end_date')}
          onChange={set('feed_end_date')}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 -mt-1 mb-3">
        <Button
          variant="secondary"
          onClick={() => applyServiceDatesToFeedInfo()}
          disabled={range === null || datesMatch}
          data-testid="feed-dates-from-service"
          title={range
            ? `Use the service calendar's span: ${prettyDate(range.start)} to ${prettyDate(range.end)}`
            : 'The feed has no service calendar dates yet'}
        >
          Set dates from service calendar
        </Button>
        <span className="text-[11px] text-warm-gray">
          {range
            ? (datesMatch ? 'Matches the service calendar.' : `Service runs ${prettyDate(range.start)} to ${prettyDate(range.end)}.`)
            : 'No service calendar yet.'}
        </span>
      </div>

      {/* ── Version ───────────────────────────────────────────────── */}
      <div className="mb-3" data-testid="field-feed-version">
        <label htmlFor="feed-version-input" className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Feed Version
        </label>
        <div className="flex gap-2">
          <input
            id="feed-version-input"
            type="text"
            value={feedInfo?.feed_version ?? ''}
            onChange={(e) => set('feed_version')(e.target.value)}
            placeholder="e.g., 20261120"
            data-testid="feed-version-input"
            className="flex-1 min-w-0 px-3 py-2 border-2 border-sand rounded-lg text-sm text-dark-brown bg-cream focus:outline-none focus:border-coral focus:bg-white"
          />
          <Button
            variant="secondary"
            className="self-center"
            onClick={() => updateFeedInfo({ feed_version: nextFeedVersion(feedInfo?.feed_version) })}
            data-testid="feed-version-bump"
            title="Set a date-based version for today (YYYYMMDD, with -2, -3 for later releases the same day)"
          >
            Bump version
          </Button>
        </div>
      </div>

      {/* ── Contact ───────────────────────────────────────────────── */}
      <FormField
        label="Contact Email"
        testId="field-feed-contact-email"
        type="email"
        value={feedInfo?.feed_contact_email ?? ''}
        onChange={set('feed_contact_email')}
        error={errorFor('feed_contact_email')}
        placeholder="gtfs@youragency.gov"
      />
      <FormField
        label="Contact URL"
        testId="field-feed-contact-url"
        type="url"
        value={feedInfo?.feed_contact_url ?? ''}
        onChange={set('feed_contact_url')}
        error={errorFor('feed_contact_url')}
        placeholder="https://youragency.gov/contact"
      />
      <p className="text-[11px] text-warm-gray -mt-2 mb-3 leading-snug">
        Where data consumers report problems with the feed. Give at least one.
      </p>

      <TranslationsEditor
        title="Feed info translations"
        targets={FEED_INFO_FIELDS.map((f) => ({
          id: `feed_info-${f.field}`,
          label: f.label,
          original: String((feedInfo as Record<string, unknown> | null)?.[f.field] ?? ''),
          table: 'feed_info' as const,
          field: f.field,
        }))}
      />
    </div>
  );
}

/** A GTFS date (YYYYMMDD) on a native date picker. An imported value the
 *  picker can't show (malformed) is surfaced by the error text, which quotes
 *  it, and is replaced by the next pick. */
function DateField({
  label, testId, value, error, onChange,
}: {
  label: string;
  testId: string;
  value: string | undefined;
  error?: string;
  onChange: (gtfsDate: string) => void;
}) {
  const malformed = !!value && !isValidGtfsDate(value);
  return (
    <FormField label={label} testId={`field-${testId}`} error={error} containerClassName="mb-3 min-w-0">
      <input
        type="date"
        value={gtfsDateToIso(value)}
        onChange={(e) => onChange(isoToGtfsDate(e.target.value))}
        aria-label={label}
        data-testid={`${testId}-input`}
        className={`w-full min-w-0 px-2 py-1.5 border-2 rounded-lg text-sm bg-cream focus:outline-none focus:border-coral ${
          error || malformed ? 'border-red-400 bg-red-50' : 'border-sand'
        }`}
      />
    </FormField>
  );
}
