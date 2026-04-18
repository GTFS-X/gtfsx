import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AdminLayout } from './AdminLayout';
import { ConfirmDialog, ErrorBanner } from './adminShared';
import { formatDateTime } from './adminFormat';
import {
  getAdminOrg,
  patchAdminOrgMember,
  removeAdminOrgMember,
  type AdminOrgDetailResponse,
  type AdminOrgMember,
} from '../../services/adminApi';
import { ApiError } from '../../services/authApi';

const ROLES: AdminOrgMember['role'][] = ['owner', 'admin', 'editor', 'viewer'];

export function AdminOrgDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [data, setData] = useState<AdminOrgDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ userId: string; msg: string } | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AdminOrgMember | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getAdminOrg(id);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load organization');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const onChangeRole = async (m: AdminOrgMember, role: AdminOrgMember['role']) => {
    if (!id || role === m.role) return;
    setBusyUserId(m.userId);
    setRowError(null);
    try {
      await patchAdminOrgMember(id, m.userId, { role });
      setBanner(`${m.email} role set to ${role}`);
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Update failed';
      setRowError({ userId: m.userId, msg });
    } finally {
      setBusyUserId(null);
    }
  };

  const onRemove = async () => {
    if (!id || !removeTarget) return;
    setBusyUserId(removeTarget.userId);
    setRowError(null);
    try {
      await removeAdminOrgMember(id, removeTarget.userId);
      setBanner(`${removeTarget.email} removed from organization`);
      setRemoveTarget(null);
      await load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Remove failed';
      setRowError({ userId: removeTarget.userId, msg });
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <AdminLayout
      title="Organization"
      subtitle={
        <Link to="/admin/orgs" className="text-coral hover:underline">
          ← Back to organizations
        </Link>
      }
    >
      {banner && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-teal-light text-teal border border-teal/30 text-sm flex items-center gap-3">
          <span className="flex-1">{banner}</span>
          <button
            onClick={() => setBanner(null)}
            className="w-7 h-7 rounded-md hover:bg-white/50"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <ErrorBanner>{error}</ErrorBanner>

      {loading && !data && <div className="text-warm-gray text-sm">Loading…</div>}

      {data && (
        <div className="space-y-5">
          <div className="bg-white border border-sand rounded-2xl p-5">
            <h2 className="font-heading font-bold text-xl text-dark-brown mb-1">
              {data.org.name}
            </h2>
            <div className="text-sm text-warm-gray">
              <span className="font-mono">{data.org.slug}</span>
              <span className="mx-2">·</span>
              Created {formatDateTime(data.org.createdAt)}
            </div>
            <div className="text-xs text-warm-gray mt-1 font-mono">{data.org.id}</div>
          </div>

          <section>
            <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">
              Members ({data.members.length})
            </h3>
            <div className="bg-white border border-sand rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Joined</th>
                    <th className="px-4 py-3 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-warm-gray">
                        No members.
                      </td>
                    </tr>
                  )}
                  {data.members.map((m) => (
                    <tr key={m.userId} className="border-t border-sand align-top">
                      <td className="px-4 py-3">
                        <Link
                          to={`/admin/users/${encodeURIComponent(m.userId)}`}
                          className="text-coral font-semibold hover:underline"
                        >
                          {m.email}
                        </Link>
                        {rowError?.userId === m.userId && (
                          <div className="mt-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                            {rowError.msg}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-dark-brown">{m.displayName || '—'}</td>
                      <td className="px-4 py-3">
                        <select
                          value={m.role}
                          onChange={(e) =>
                            onChangeRole(m, e.target.value as AdminOrgMember['role'])
                          }
                          disabled={busyUserId === m.userId}
                          className="px-2 py-1 border border-sand rounded-md bg-white text-sm text-dark-brown focus:outline-none focus:border-coral"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-warm-gray">{formatDateTime(m.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => {
                            setRowError(null);
                            setRemoveTarget(m);
                          }}
                          disabled={busyUserId === m.userId}
                          className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">
              Projects ({data.projects.length})
            </h3>
            <div className="bg-white border border-sand rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Slug</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-warm-gray">
                        No projects owned by this org.
                      </td>
                    </tr>
                  )}
                  {data.projects.map((p) => (
                    <tr key={p.id} className="border-t border-sand hover:bg-cream/40">
                      <td className="px-4 py-3 text-dark-brown font-semibold">{p.name}</td>
                      <td className="px-4 py-3 text-warm-gray font-mono text-xs">{p.slug}</td>
                      <td className="px-4 py-3 text-warm-gray">
                        {formatDateTime(p.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Remove member?"
          body={`${removeTarget.email} will be removed from ${data?.org.name ?? 'this org'}.${
            removeTarget.role === 'owner'
              ? ' Owner removal requires at least one other owner remaining.'
              : ''
          }`}
          confirmLabel="Remove"
          danger
          busy={busyUserId === removeTarget.userId}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={onRemove}
        />
      )}

    </AdminLayout>
  );
}
