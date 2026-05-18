import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { getMyForumProfile, patchMyForumProfile, type ForumProfile } from '../../services/forumApi';
import { Avatar } from './Avatar';

export function ProfileEditor() {
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ForumProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [gravatarOptOut, setGravatarOptOut] = useState(false);
  const [prefs, setPrefs] = useState({ replies: true, subscribed: true, markSolved: true, adminAlerts: true, allOff: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    getMyForumProfile()
      .then(({ profile }) => {
        if (cancelled) return;
        setProfile(profile);
        setDisplayName(profile.displayName ?? currentUser.displayName ?? '');
        setGravatarOptOut(profile.gravatarOptOut);
        setPrefs(profile.emailPrefs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  if (!currentUser) {
    return (
      <div className="bg-white border border-sand rounded-lg p-6">
        <p className="text-sm text-warm-gray mb-2">Sign in to edit your community profile.</p>
        <button
          onClick={() => navigate(`/login?next=${encodeURIComponent('/community/profile')}`)}
          className="px-3 py-2 rounded-lg text-sm font-heading font-bold bg-coral text-white hover:bg-[#d4603a]"
        >
          Sign in
        </button>
      </div>
    );
  }
  if (!profile) return <div className="text-warm-gray text-sm">Loading…</div>;

  const handleSave = async () => {
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      const res = await patchMyForumProfile({
        displayName: displayName.trim(),
        gravatarOptOut,
        emailPrefs: prefs,
      });
      setProfile(res.profile);
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Link to="/community" className="text-xs text-warm-gray hover:text-coral">← Community</Link>
        <h1 className="font-heading font-bold text-2xl text-dark-brown mt-1">Your community profile</h1>
        <p className="text-sm text-warm-gray mt-1">
          How you appear to other GTFS·X users in the forum. This is separate from your account settings.
        </p>
      </div>

      <section className="bg-white border border-sand rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-4">
          <Avatar gravatarHash={profile.gravatarHash} displayName={profile.displayName ?? 'You'} size={64} />
          <div>
            <div className="text-xs text-warm-gray">Avatar comes from <a href="https://gravatar.com" target="_blank" rel="noopener noreferrer" className="text-coral underline">Gravatar</a>, keyed to your account email.</div>
            <label className="flex items-center gap-2 mt-2 text-xs text-warm-gray cursor-pointer">
              <input
                type="checkbox"
                checked={gravatarOptOut}
                onChange={(e) => setGravatarOptOut(e.target.checked)}
              />
              Use a generic avatar instead (skips Gravatar lookup)
            </label>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-warm-gray uppercase tracking-wide mb-1">Display name</label>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="What other users see"
            maxLength={40}
            className="w-full px-3 py-2 border border-sand rounded-md text-sm outline-none focus:border-coral"
          />
          <p className="text-[11px] text-warm-gray mt-1">
            2–40 characters. Required before you can post or upvote.
          </p>
        </div>
      </section>

      <section className="bg-white border border-sand rounded-lg p-4 space-y-2">
        <h2 className="font-heading font-bold text-sm text-dark-brown">Email notifications</h2>
        <PrefRow label="Reply to a thread I started" checked={prefs.replies} onChange={(v) => setPrefs({ ...prefs, replies: v })} />
        <PrefRow label="Reply on a thread I'm following" checked={prefs.subscribed} onChange={(v) => setPrefs({ ...prefs, subscribed: v })} />
        <PrefRow label="My reply marked as the accepted answer" checked={prefs.markSolved} onChange={(v) => setPrefs({ ...prefs, markSolved: v })} />
        {profile.isStaff && (
          <PrefRow label="Admin alert on every new thread (staff)" checked={prefs.adminAlerts} onChange={(v) => setPrefs({ ...prefs, adminAlerts: v })} />
        )}
        <div className="border-t border-sand pt-2 mt-2">
          <PrefRow label="Turn off all community emails" checked={prefs.allOff} onChange={(v) => setPrefs({ ...prefs, allOff: v })} />
        </div>
      </section>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">{error}</div>
      )}
      {success && (
        <div className="px-3 py-2 rounded-md bg-teal-light border border-teal/30 text-teal text-xs">Saved.</div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving || displayName.trim().length < 2}
          className="px-4 py-2 rounded-lg text-sm font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function PrefRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-dark-brown cursor-pointer hover:bg-cream/40 px-1 py-1 rounded">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
