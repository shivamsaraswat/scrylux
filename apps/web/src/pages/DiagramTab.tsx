import { ReactFlowProvider } from '@xyflow/react';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { Canvas } from '../diagram/Canvas.js';
import { DiagramErrorBoundary } from '../diagram/DiagramErrorBoundary.js';
import { DeleteDialogs } from '../diagram/DeleteDialogs.js';
import { useDiagramEditor } from '../diagram/DiagramEditorProvider.js';
import { ElementThreats } from '../diagram/ElementThreats.js';
import { ElementsList } from '../diagram/ElementsList.js';
import { PropertiesPanel } from '../diagram/PropertiesPanel.js';
import { SelectionAnnouncer } from '../diagram/SelectionAnnouncer.js';
import { Toolbar } from '../diagram/Toolbar.js';

// The Diagram tab: the threat model's data-flow diagram. Its state lives in the editor provider above
// the tabs; React Flow's provider is here so the toolbar can reach the viewport. If the screen breaks, the
// boundary stands in for it and the editor keeps saving.
export function DiagramTab() {
  // A link from the Assets tab (Phase 3 Milestone 5) opens the diagram with an element selected: `?element=<id>`.
  const [params] = useSearchParams();
  const editor = useDiagramEditor();
  const wanted = params.get('element');
  const select = editor.select;
  const loaded = editor.elements !== undefined;
  const exists = editor.elements?.some((candidate) => candidate.id === wanted) === true;
  useEffect(() => {
    if (wanted !== null && loaded && exists) select([wanted]);
  }, [wanted, loaded, exists, select]);
  return (
    <DiagramErrorBoundary>
      <ReactFlowProvider>
        <Toolbar />
        <div className="diagram-layout">
          <ElementsList />
          <Canvas />
          <PropertiesPanel />
        </div>
        <SelectionAnnouncer />
        <DeleteDialogs />
      </ReactFlowProvider>
      {/* Outside the canvas and its provider: typing here never reaches the diagram's keys (spec edge case). */}
      <ElementThreats />
    </DiagramErrorBoundary>
  );
}
