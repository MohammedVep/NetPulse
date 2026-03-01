import { DashboardShell } from "@/components/dashboard-shell";

interface OrgDashboardPageProps {
  params: Promise<{ orgId: string }>;
}

export default async function OrgDashboardPage({ params }: OrgDashboardPageProps) {
  const { orgId } = await params;
  return <DashboardShell orgId={decodeURIComponent(orgId)} />;
}
