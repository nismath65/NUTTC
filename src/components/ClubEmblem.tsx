import React from 'react';

export default function ClubEmblem({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Paddle blade */}
      <circle
        cx="13"
        cy="11.5"
        r="7.5"
        fill="#EBF3EE"
        stroke="#14533C"
        strokeWidth="1.75"
      />
      {/* Rubber edge arc */}
      <path
        d="M7.5 15.5C9.5 14 14 14 18.5 15.5"
        stroke="#14533C"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeDasharray="2 2"
      />
      {/* Handle */}
      <path
        d="M17 17.5L21.5 23.5"
        stroke="#14533C"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* Table tennis ball */}
      <circle
        cx="22.5"
        cy="6.5"
        r="2.6"
        fill="#C2412D"
        stroke="#FFFFFF"
        strokeWidth="1"
      />
    </svg>
  );
}
