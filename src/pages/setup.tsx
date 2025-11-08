import type { NextPage } from 'next';
import dynamic from 'next/dynamic';

const Setup = dynamic(() => import('@app/components/Setup'), { ssr: false });

const SetupPage: NextPage = () => {
  return <Setup />;
};

export default SetupPage;
