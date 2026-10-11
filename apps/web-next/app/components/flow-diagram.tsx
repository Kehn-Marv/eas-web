'use client';

import { useMemo } from 'react';
import { ReactFlow, Node, Edge, Background, BackgroundVariant, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import type { FlowConfig, SimpleNode, SimpleEdge } from '../../lib/types';

export type { FlowConfig, SimpleNode, SimpleEdge };

const COLOR_MAP = {
  start: {
    background: 'var(--color-hint-bg)',
    border: 'var(--color-hint)',
  },
  process: {
    background: 'var(--color-info-bg)',
    border: 'var(--color-info)',
  },
  output: {
    background: 'var(--color-correct-bg)',
    border: 'var(--color-correct)',
  },
};

function getLayoutedElements(simpleNodes: SimpleNode[], simpleEdges: SimpleEdge[]): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  
  // Configure layout
  dagreGraph.setGraph({ 
    rankdir: 'TB', // Top to bottom
    nodesep: 80,   // Horizontal spacing
    ranksep: 100,  // Vertical spacing
  });

  // Add nodes to dagre
  simpleNodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 200, height: 60 });
  });

  // Add edges to dagre
  simpleEdges.forEach(([source, target]) => {
    dagreGraph.setEdge(source, target);
  });

  // Calculate layout
  dagre.layout(dagreGraph);

  // Convert to React Flow format
  const nodes: Node[] = simpleNodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const colors = COLOR_MAP[node.type];
    
    return {
      id: node.id,
      position: {
        x: nodeWithPosition.x - 100, // Center the node (width/2)
        y: nodeWithPosition.y - 30,  // Center the node (height/2)
      },
      data: { label: node.label },
      style: {
        background: colors.background,
        border: `2px solid ${colors.border}`,
        borderRadius: 8,
        padding: 12,
        fontSize: 14,
        fontWeight: 500,
        whiteSpace: 'pre-line' as const,
        textAlign: 'center' as const,
        minWidth: 180,
        color: 'var(--color-foreground)',
      },
    };
  });

  const edges: Edge[] = simpleEdges.map(([source, target], index) => ({
    id: `e${index}`,
    source,
    target,
    animated: true,
  }));

  return { nodes, edges };
}

interface FlowDiagramProps {
  config: FlowConfig;
  className?: string;
}

export function FlowDiagram({ config, className }: FlowDiagramProps) {
  const { nodes, edges } = useMemo(
    () => getLayoutedElements(config.nodes, config.edges),
    [config]
  );

  return (
    <div className={className} style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{
          padding: 0.2, // 20% padding around the diagram
          minZoom: 0.5,
          maxZoom: 1.5,
        }}
        attributionPosition="bottom-left"
        zoomOnScroll={false}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        panOnDrag={true}
        preventScrolling={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{
          hideAttribution: true,
        }}
      >
        <Background
          color="var(--color-border-strong)"
          gap={16}
          variant={BackgroundVariant.Dots}
        />
        <Controls 
          showZoom={true}
          showFitView={true}
          showInteractive={false}
          position="bottom-right"
        />
      </ReactFlow>
    </div>
  );
}

