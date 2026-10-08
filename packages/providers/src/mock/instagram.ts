import type { InstagramDataProvider, InstagramPostMetrics } from '../types.js';

const FIXTURE: InstagramPostMetrics[] = [
  {
    postId: 'mock-1',
    permalink: null,
    mediaType: 'REELS',
    caption: 'Mock reel',
    postedAt: '2026-09-01T10:00:00.000Z',
    metrics: { reach: 1200, likes: 85, comments: 7, saves: 22, shares: 9, plays: 3100 },
    source: 'mock',
  },
  {
    postId: 'mock-2',
    permalink: null,
    mediaType: 'CAROUSEL_ALBUM',
    caption: 'Mock carousel',
    postedAt: '2026-09-03T10:00:00.000Z',
    metrics: { reach: 800, likes: 60, comments: 3, saves: 40, shares: 4 },
    source: 'mock',
  },
];

/** Fixed fixture data; clearly labelled `source: "mock"` so it can never pass as real numbers. */
export class MockInstagramDataProvider implements InstagramDataProvider {
  readonly name = 'mock';

  constructor(private readonly posts: InstagramPostMetrics[] = FIXTURE) {}

  listPosts(range: { since?: Date; until?: Date }): Promise<InstagramPostMetrics[]> {
    return Promise.resolve(
      this.posts.filter((p) => {
        const t = new Date(p.postedAt).getTime();
        return (
          (!range.since || t >= range.since.getTime()) &&
          (!range.until || t <= range.until.getTime())
        );
      }),
    );
  }
}
