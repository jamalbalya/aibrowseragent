/**
 * The one outbound link in the extension's interface.
 *
 * Two constraints shape it, and they pull in opposite directions. The store
 * listing carries "Created by Jamal Balya"; the extension's own interface
 * deliberately does not, and the release audit checks that the string is absent
 * from the bundle. A profile link is allowed. A byline is not.
 *
 * So this renders an icon and an accessible name, and no attribution text.
 *
 * Why it is safe to have an external link here at all:
 *
 *  - The URL is a module constant. Nothing the model produces, nothing a page
 *    supplies and nothing in storage can reach it, so there is no route by
 *    which a link in the trusted panel could be pointed somewhere else.
 *  - It is a user's own click on a link in the extension's UI, which opens an
 *    ordinary tab. It is not an agent action, so it does not pass through
 *    `evaluatePolicy` — and it must not, because policy governs what the agent
 *    may do rather than what the person driving it may do.
 *  - `rel="noopener noreferrer"` so the opened page gets no handle back and no
 *    referrer, and `target="_blank"` so the panel is not navigated away from
 *    the task in progress.
 *  - The glyph is inline SVG rather than a fetched asset, so it needs no
 *    network request and no CSP relaxation.
 */
import React from 'react';

/** Fixed at build time. Deliberately not configurable. */
export const PROFILE_URL = 'https://www.linkedin.com/in/jamalbalya';

export function AboutLink(): React.JSX.Element {
  return (
    <p className="about">
      <a
        className="about__link"
        href={PROFILE_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="LinkedIn profile"
        title="LinkedIn profile"
      >
        <svg
          className="about__icon"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          role="img"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M4.98 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM3 9h4v12H3V9Zm7 0h3.8v1.71h.05a4.17 4.17 0 0 1 3.75-2.06c4 0 4.75 2.64 4.75 6.07V21h-4v-5.39c0-1.29-.02-2.95-1.8-2.95-1.8 0-2.07 1.4-2.07 2.85V21h-4V9Z"
          />
        </svg>
      </a>
    </p>
  );
}
