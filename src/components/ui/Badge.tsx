import React from 'react';

interface BadgeProps {
  variant: 'error' | 'warning' | 'success' | 'info';
  children: React.ReactNode;
}

const styles: Record<string, string> = {
  error: 'bg-red-100 text-red-700',
  warning: 'bg-gold-light text-amber-700',
  success: 'bg-teal-light text-teal',
  info: 'bg-purple-light text-purple',
};

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${styles[variant]}`}>
      {children}
    </span>
  );
}
