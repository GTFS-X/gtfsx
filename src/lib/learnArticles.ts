// Source of truth for the SPA's "Learn" nav dropdown (CommunityRoot, HelpPage).
// The static-page equivalent lives in public/assets/site-nav.js (window.GTFSX_LEARN);
// keep the two lists in sync when adding a learn article.
export interface LearnArticle {
  path: string;
  title: string;
}

export const LEARN_ARTICLES: LearnArticle[] = [
  { path: '/learn/gtfs/', title: 'What is GTFS?' },
  { path: '/learn/gtfs-flex/', title: 'What is GTFS-Flex?' },
  { path: '/learn/publish-gtfs-feed/', title: 'How to Publish a GTFS Feed' },
];
