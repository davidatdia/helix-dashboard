import { 
    NodesEdgesResponse, 
    SchemaInfo, 
    DataItem, 
    ConnectionData, 
    NodeDetailsResponse 
} from '../types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';

// ============================================================================
// ID Normalization
// ============================================================================
// The HelixDB backend returns IDs in two formats:
// 1. Numeric strings from /nodes-edges: "41271497485366718861022651888053781766"
// 2. UUID strings from /node-connections: "1f0c99ed-da7a-6901-a529-010203040506"
//
// These represent the same underlying entity (numeric is the decimal
// representation of the 128-bit UUID). We normalize to UUID format at the
// API boundary for consistency throughout the application.
// ============================================================================

export const normalizeId = (id: unknown): string => {
    const str = String(id);
    
    // Already a UUID format (8-4-4-4-12 pattern)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
        return str.toLowerCase();
    }
    
    // Check if it's a large numeric string (potential decimal representation of UUID)
    // UUIDs are 128-bit, so decimal representation is up to 39 digits
    if (/^\d{20,}$/.test(str)) {
        try {
            // Convert decimal to hex, then format as UUID
            const bigInt = BigInt(str);
            const hex = bigInt.toString(16).padStart(32, '0');
            const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
            return uuid.toLowerCase();
        } catch {
            // If conversion fails, fall back to string
            return str;
        }
    }
    
    return str;
};

// Normalize a node's ID
const normalizeNode = (node: DataItem): DataItem => {
    const id = normalizeId(node.id);
    return { ...node, id };
};

// Normalize edge endpoints
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normalizeEdge = (edge: any): any => {
    if (!edge) return edge;
    return {
        ...edge,
        from_node: edge.from_node ? normalizeId(edge.from_node) : edge.from_node,
        to_node: edge.to_node ? normalizeId(edge.to_node) : edge.to_node,
        from: edge.from ? normalizeId(edge.from) : edge.from,
        to: edge.to ? normalizeId(edge.to) : edge.to,
    };
};

export const fetchSchema = async (): Promise<SchemaInfo> => {
    const response = await fetch(`${API_BASE}/api/schema`);
    const data: SchemaInfo = await response.json();
    return data;
};

export const fetchNodesByLabel = async (
    label: string, 
    limit?: number
): Promise<{ nodes: DataItem[] }> => {
    const params = new URLSearchParams();
    params.append('label', label);
    if (limit) params.append('limit', limit.toString());
    
    const response = await fetch(`${API_BASE}/api/nodes-by-label?${params}`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    // Normalize node IDs at the API boundary
    return {
        ...data,
        nodes: (data.nodes || []).map(normalizeNode)
    };
};

export const fetchNodesAndEdges = async (limit?: number): Promise<NodesEdgesResponse> => {
    const params = limit ? `?limit=${limit}` : '';
    const response = await fetch(`${API_BASE}/api/nodes-edges${params}`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data: NodesEdgesResponse = await response.json();
    // Normalize node IDs at the API boundary
    if (data.data) {
        data.data.nodes = (data.data.nodes || []).map(normalizeNode);
        data.data.edges = (data.data.edges || []).map(normalizeEdge);
    }
    return data;
};

export const fetchNodeConnections = async (nodeId: string): Promise<ConnectionData> => {
    const response = await fetch(
        `${API_BASE}/api/node-connections?node_id=${encodeURIComponent(nodeId)}`
    );
    if (!response.ok) {
        throw new Error(`Failed to fetch connections: ${response.status}`);
    }
    const connectionsText = await response.text();
    const data: ConnectionData = JSON.parse(connectionsText);
    // Normalize all IDs at the API boundary
    return {
        ...data,
        connected_nodes: (data.connected_nodes || []).map(normalizeNode),
        incoming_edges: (data.incoming_edges || []).map(normalizeEdge),
        outgoing_edges: (data.outgoing_edges || []).map(normalizeEdge),
    };
};

export const fetchNodeDetails = async (nodeId: string): Promise<NodeDetailsResponse> => {
    const response = await fetch(
        `${API_BASE}/api/node-details?id=${encodeURIComponent(nodeId)}`
    );
    if (!response.ok) {
        throw new Error(`Failed to fetch node details: ${response.status}`);
    }
    return response.json();
};

export const fetchNodeDetailsForNodes = async (
    nodes: Map<string, DataItem>
): Promise<Map<string, DataItem>> => {
    const nodeIds = Array.from(nodes.keys());
    const batchSize = 10;
    const updatedNodes = new Map(nodes);

    for (let i = 0; i < nodeIds.length; i += batchSize) {
        const batch = nodeIds.slice(i, i + batchSize);

        const batchPromises = batch.map(async (nodeId) => {
            try {
                const details = await fetchNodeDetails(nodeId);
                return { nodeId, details };
            } catch {
                return null;
            }
        });

        const batchResults = await Promise.all(batchPromises);

        batchResults.forEach((result) => {
            if (result && result.details) {
                const existingNode = updatedNodes.get(result.nodeId);
                if (existingNode) {
                    let nodeData = null;

                    if (result.details.found && result.details.node) {
                        nodeData = result.details.node;
                    } else if (result.details.data) {
                        nodeData = result.details.data;
                    } else {
                        nodeData = result.details;
                    }

                    if (nodeData && typeof nodeData === 'object') {
                        updatedNodes.set(result.nodeId, {
                            ...existingNode,
                            ...nodeData,
                            id: result.nodeId
                        });
                    }
                }
            }
        });
    }

    return updatedNodes;
};

export const discoverNodeTypesFromData = async (): Promise<SchemaInfo> => {
    try {
        const result = await fetchNodesAndEdges(100);
        const nodes = result.data?.nodes || [];
        const nodeTypes = new Set<string>();

        for (let i = 0; i < Math.min(nodes.length, 20); i++) {
            const node = nodes[i];
            try {
                const details = await fetchNodeDetails(node.id);
                let nodeData = null;

                if (details.found && details.node) {
                    nodeData = details.node;
                } else if (details.data) {
                    nodeData = details.data;
                } else {
                    nodeData = details;
                }

                if (nodeData && nodeData.label) {
                    nodeTypes.add(nodeData.label);
                }
            } catch {
                continue;
            }
        }

        return {
            nodes: Array.from(nodeTypes).map(type => ({ name: type, properties: [] })),
            edges: []
        };
    } catch {
        return { nodes: [], edges: [] };
    }
};