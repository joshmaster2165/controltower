import type { ReactNode } from 'react';

/** The one page header: title, a short description, and actions on the right. */
export function PageHeader({ title, description, actions, meta }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>
          {title}
          {meta && <span className="page-meta">{meta}</span>}
        </h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
