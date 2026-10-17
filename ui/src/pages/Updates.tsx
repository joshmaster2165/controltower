import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader } from '../components/PageHeader';
import { CodeBlock } from '../components/CodeBlock';

interface Release {
  version: string;
  date: string;
  security: boolean;
  summary: string;
  notes: string[];
  url: string;
}
export interface UpdateStatus {
  current: string;
  latest: string | null;
  update_available: boolean;
  security: boolean;
  newer: Release[];
  checked_at: number | null;
  check: 'on' | 'off';
  error: string | null;
  how: { platform: string; label: string; steps: string[]; commands: string[] };
  data: {
    database: 'sqlite' | 'postgres';
    on_volume: boolean | null;
    backups: Array<{ name: string; size: number; created_at: number; schema: number | null; from_version: string | null; before_version: string | null }>;
    backups_dir: string | null;
  };
  history: Array<{ at: number; from_version: string | null; to_version: string; from_schema: number; to_schema: number; backup: string | null }>;
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const size = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`);
const DISMISS = 'ct.updates.dismissed';

/** At the top of the console, for admins: a new version (louder for a security fix), or data that an update would lose. */
export function UpdateBanner({ isAdmin }: { isAdmin: boolean }) {
  const [s, setS] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!isAdmin) return;
    const load = () => void api.get<UpdateStatus>('/admin/api/updates').then(setS).catch(() => undefined);
    load();
    const t = setInterval(load, 6 * 3600_000);
    return () => clearInterval(t);
  }, [isAdmin]);
  if (!s) return null;
  if (s.data.on_volume === false)
    return (
      <div className="role-banner warn" role="alert">
        The data directory isn’t on a volume of its own: updating (or restarting on a new container) would start Control Tower from scratch. Give it a persistent volume at <code>/data</code>. <a href="#/updates">Updates</a>
      </div>
    );
  if (!s.update_available || (!s.security && dismissed === s.latest)) return null;
  return (
    <div className={`role-banner ${s.security ? 'warn' : ''}`} role="status">
      {s.security ? <b>Security update: </b> : null}Control Tower {s.latest} is available (this is {s.current}). <a href="#/updates">What’s new and how to update</a>
      {!s.security && (
        <button
          className="linklike"
          style={{ marginLeft: 10 }}
          onClick={() => {
            try {
              localStorage.setItem(DISMISS, s.latest ?? '');
            } catch {
              /* private mode */
            }
            setDismissed(s.latest);
          }}
        >
          Later
        </button>
      )}
    </div>
  );
}

export function UpdatesPage() {
  const [s, setS] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api
      .get<UpdateStatus>('/admin/api/updates')
      .then(setS)
      .catch((e: Error) => setErr(e.message));
  }, []);
  const checkNow = async () => {
    setBusy(true);
    try {
      setS(await api.post<UpdateStatus>('/admin/api/updates/check'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!s) return <div className="page">{err ? <p className="hint">{err}</p> : <p className="hint">Loading…</p>}</div>;
  const target = s.newer[0]?.version ?? s.current;
  return (
    <div className="page updates">
      <PageHeader
        title="Updates"
        description="New versions of Control Tower, and how to install them where this one runs. Your data stays: it's upgraded in place, and backed up first."
        actions={
          <button className="btn" onClick={() => void checkNow()} disabled={busy || s.check === 'off'} title={s.check === 'off' ? 'The check is off (CT_UPDATE_CHECK=off)' : 'Fetch the release feed now'}>
            {busy ? 'Checking…' : 'Check now'}
          </button>
        }
      />
      <div className="card up-now">
        <div>
          <div className="up-k">This version</div>
          <div className="up-v">{s.current}</div>
        </div>
        <div>
          <div className="up-k">Latest</div>
          <div className="up-v">
            {s.latest ?? '—'} {s.update_available ? <span className={`tag ${s.security ? 'danger' : ''}`}>{s.security ? 'security update' : 'update available'}</span> : s.latest ? <span className="tag ok">up to date</span> : null}
          </div>
        </div>
        <div className="up-checked">
          {s.check === 'off'
            ? 'Checking is off (CT_UPDATE_CHECK=off): see the changelog for new versions.'
            : s.checked_at
              ? `Checked ${when(s.checked_at)}.`
              : 'Not checked yet: the first check is a minute after start.'}
          {s.error ? ` The last check failed: ${s.error}.` : ''}
          <div className="hint">The daily check sends only this version number. Turn it off with CT_UPDATE_CHECK=off.</div>
        </div>
      </div>

      {s.update_available && (
        <section className="card">
          <h3>What’s new since {s.current}</h3>
          <ul className="up-releases">
            {s.newer.map((r) => (
              <li key={r.version}>
                <div className="up-rel-h">
                  <b>{r.version}</b> <span className="hint">{r.date}</span> {r.security && <span className="tag danger">security</span>}
                  {r.url && (
                    <a href={r.url} target="_blank" rel="noreferrer">
                      Changelog
                    </a>
                  )}
                </div>
                <div>{r.summary}</div>
                {r.notes.map((n) => (
                  <div key={n} className="up-note">
                    {n}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>
          {s.update_available ? `Update to ${target}` : 'How to update'} · {s.how.label}
        </h3>
        <ol className="up-steps">
          {s.how.steps.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
        {s.how.commands.length > 0 && <CodeBlock title={s.how.label} code={s.how.commands.join('\n')} />}
        <p className="hint">
          {s.data.database === 'sqlite'
            ? 'Before the new version changes the database, it copies it to the backups below (and won’t start without room for the copy). If you need to go back, restore that backup and start the older version.'
            : 'The data is in Postgres: take a snapshot with your database provider before updating if you want to be able to go back.'}{' '}
          An older version refuses to start on data a newer one has upgraded, and says which backup to restore.
        </p>
      </section>

      <section className="card">
        <h3>Your data</h3>
        <p>
          {s.data.database === 'postgres'
            ? 'In Postgres: updates and restarts keep it.'
            : s.data.on_volume === false
              ? 'On the container’s own disk, not a volume: an update or a new container starts from scratch. Mount a persistent volume at /data.'
              : s.data.on_volume
                ? 'On a persistent volume: updates and restarts keep it.'
                : `In ${s.data.backups_dir?.replace(/\/backups$/, '') ?? 'the data directory'}: updates keep it.`}
        </p>
        {s.data.database === 'sqlite' && (
          <>
            <div className="up-k" style={{ marginTop: 12 }}>
              Backups taken before upgrades
            </div>
            {s.data.backups.length ? (
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Backup</th>
                    <th>Taken</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {s.data.backups.map((b) => (
                    <tr key={b.name}>
                      <td>
                        {b.before_version ? `Before ${b.before_version}` : 'Set aside by a restore'}
                        {b.from_version ? ` (from ${b.from_version})` : ''}
                        <div className="hint mono">{b.name}</div>
                      </td>
                      <td>{when(b.created_at)}</td>
                      <td>{size(b.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="hint">None yet: one is taken the first time an update changes the database.</p>
            )}
            <p className="hint">
              To go back: stop Control Tower, put the backup back with this version (in Docker: <code>docker run --rm -v controltower-data:/data ghcr.io/joshmaster2165/controltower:{s.current} --restore &lt;backup&gt;</code>), then start the version the backup came from.
            </p>
          </>
        )}
      </section>

      {s.history.length > 0 && (
        <section className="card">
          <h3>Update history</h3>
          <table className="table compact">
            <tbody>
              {s.history.map((h) => (
                <tr key={h.at}>
                  <td>{when(h.at)}</td>
                  <td>
                    {h.from_version ?? 'an earlier version'} → {h.to_version}
                  </td>
                  <td className="hint">{h.from_schema !== h.to_schema ? `database ${h.from_schema} → ${h.to_schema}` : 'no database changes'}</td>
                  <td className="hint">{h.backup ? `backed up first` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
