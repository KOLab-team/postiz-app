import { InstagramInbox } from '@gitroom/frontend/components/instagram-dms/instagram-inbox';
import { Metadata } from 'next';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Instagram Inbox | Postiz' };

export default function Page() {
  return <InstagramInbox />;
}
