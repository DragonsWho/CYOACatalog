import React from 'react';
import { Link } from '@mui/material';
import { ClientResponseError } from 'pocketbase';

// On failed validation PB returns a useless "Failed to update/create record." and hides the reason
// per field in data ("The username is invalid or already in use"). Surface the field messages.
export const pbErrorText = (err: unknown): string => {
  if (!(err instanceof ClientResponseError)) return (err as Error).message;
  const data = (err.response as { data?: Record<string, { message?: string }> })?.data;
  const fieldMsgs = data
    ? Object.entries(data)
        .map(([field, info]) => (info?.message ? `${field}: ${info.message}` : ''))
        .filter(Boolean)
    : [];
  if (fieldMsgs.length) return fieldMsgs.join(' ');
  return err.message;
};

// The server can't pass a link as a separate field: PB collapses custom data into {code, message}
// (safeErrorsData). So the URL rides inside the message text (reservedUsernameMessage in
// usernames.go) — linkify it here.
export const LinkifiedText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(https?:\/\/[^\s,)]+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <Link key={i} href={part} target="_blank" rel="noopener noreferrer" sx={{ fontWeight: 600 }}>
          {part.replace(/^https?:\/\//, '')}
        </Link>
      ) : (
        part
      ),
    )}
  </>
);
