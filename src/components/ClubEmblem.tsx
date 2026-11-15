import React from 'react';

export default function ClubEmblem({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <img
      src="/public/logo.png"
      alt="NUTTC"
      className={`${className} object-contain`}
    />
  );
}
