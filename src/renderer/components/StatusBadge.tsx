import React from 'react';

interface StatusBadgeProps {
  variant: 'success' | 'warn' | 'danger' | 'neutral' | 'accent';
  label: string;
  dot?: boolean;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  variant,
  label,
  dot = true,
}) => (
  <span className={`badge badge-${variant}`}>
    {dot && <span className="badge-dot" />}
    {label}
  </span>
);
