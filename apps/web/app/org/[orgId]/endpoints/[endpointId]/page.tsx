import { EndpointDetail } from "@/components/endpoint-detail";

interface EndpointDetailPageProps {
  params: Promise<{ endpointId: string }>;
}

export default async function EndpointDetailPage({ params }: EndpointDetailPageProps) {
  const { endpointId } = await params;
  return <EndpointDetail endpointId={decodeURIComponent(endpointId)} />;
}
