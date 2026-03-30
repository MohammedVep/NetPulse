import { EndpointDetail } from "@/components/endpoint-detail";

interface EndpointDetailPageProps {
  params: Promise<{ orgId: string; endpointId: string }>;
}

export default async function EndpointDetailPage({ params }: EndpointDetailPageProps) {
  const { orgId, endpointId } = await params;
  return <EndpointDetail orgId={decodeURIComponent(orgId)} endpointId={decodeURIComponent(endpointId)} />;
}
