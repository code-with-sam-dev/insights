/**
 * What each platform pays for, and how far away that is.
 *
 * WARNING, and this is the important part of this file: every threshold below
 * is a product decision by a company that can change it whenever it likes.
 * They are recorded with the date they were checked so a stale number is
 * visible as stale rather than trusted forever. The dashboard shows this date.
 * Re-verify before making a real decision on any of them.
 *
 * `dataSource` says where the numbers come from, and is deliberately honest:
 *
 *   api      pulled automatically
 *   manual   typed into data/manual.json, because the platform gates its API
 *   blocked  no route to the data at all right now
 *
 * A blocked platform renders as blocked. It never renders as zero, because
 * "no data" and "no progress" lead to opposite decisions.
 */

export const THRESHOLDS_VERIFIED = '2026-09-11';

export const PLATFORMS = [
  {
    id: 'youtube',
    name: 'YouTube',
    url: 'https://www.youtube.com/@CodewithSam-Dev',
    dataSource: 'api',
    role: 'The channel itself. Everything else links back here.',
    monetisation: {
      name: 'YouTube Partner Programme',
      note: 'Watch hours and Shorts views are alternative routes, so the nearer of the two is what actually counts.',
      requirements: [
        {metric: 'subscribers', target: 1000, label: 'subscribers'},
        {metric: 'watchHours', target: 4000, label: 'public watch hours in 12 months'},
      ],
    },
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    url: 'https://www.tiktok.com/@codewithsamdev',
    dataSource: 'manual',
    role: 'Largest reach per unit of effort, and the cheapest place to test a hook.',
    monetisation: {
      name: 'Creator Rewards',
      // Readable by hand, but closed for monetisation. Two different facts.
      blocked: true,
      blockedReason:
        'Creator Rewards needs a business account, and the free switch for one no longer exists in the app. The follower and view numbers are still tracked, because they matter for sponsorship even though the programme is shut.',
      requirements: [
        {metric: 'followers', target: 10000, label: 'followers'},
        {metric: 'views30d', target: 100000, label: 'views in 30 days'},
      ],
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    url: 'https://www.instagram.com/codewithsamdev',
    dataSource: 'manual',
    role: 'Reels take the same vertical cut as TikTok, so near zero extra effort.',
    monetisation: {
      name: 'Brand deals',
      note: 'No public threshold. Instagram bonuses are invitation only, so the realistic route is sponsorship, which is negotiated rather than unlocked. The follower target here is a working proxy for when a sponsor will take a meeting, not a rule of the platform.',
      requirements: [{metric: 'followers', target: 5000, label: 'followers'}],
    },
  },
  {
    id: 'facebook',
    name: 'Facebook',
    url: 'https://www.facebook.com/profile.php?id=61594191065024',
    dataSource: 'manual',
    role: 'Claimed defensively. Reels reach beyond followers, which suits a new page.',
    monetisation: {
      name: 'Facebook in-stream and Reels',
      requirements: [
        {metric: 'followers', target: 5000, label: 'page followers'},
        {metric: 'minutesViewed60d', target: 60000, label: 'minutes viewed in 60 days'},
      ],
    },
  },
  {
    id: 'x',
    name: 'X',
    url: 'https://x.com/CodeWithSamDev',
    dataSource: 'manual',
    role: 'The only platform where links in a post are clickable. Best cross-linking surface.',
    monetisation: {
      name: 'Creator revenue sharing',
      note: 'Also requires a paid X Premium subscription, which is a cost rather than a threshold, so it is not modelled as a requirement.',
      requirements: [
        {metric: 'followers', target: 500, label: 'followers'},
        {metric: 'impressions90d', target: 5000000, label: 'impressions in 90 days'},
      ],
    },
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    url: 'https://www.linkedin.com/company/code-with-sam-dev',
    dataSource: 'manual',
    role: 'Highest intent audience, and the page a sponsor checks before paying.',
    monetisation: {
      name: 'Consulting enquiries',
      note: 'LinkedIn pays nothing directly. It is the shortest path to paid work, so the metric that matters is enquiries through the contact form, not followers. Track it by hand.',
      requirements: [{metric: 'enquiries', target: 1, label: 'consulting enquiries'}],
    },
  },
];

export const byId = (id) => PLATFORMS.find((p) => p.id === id);
