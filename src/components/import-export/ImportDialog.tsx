import React, { useState, useCallback } from 'react';
import { importGtfsZip, loadImportIntoStore } from '../../services/gtfsImport';
import { useStore } from '../../store';

interface ImportDialogProps {
  onClose: () => void;
}

export function ImportDialog({ onClose }: ImportDialogProps) {
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    agencies: number;
    routes: number;
    stops: number;
    trips: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setImporting(true);
    setError(null);
    try {
      const data = await importGtfsZip(file);
      loadImportIntoStore(data);
      useStore.getState().setProjectName(file.name.replace(/\.zip$/i, ''));
      setResult({
        agencies: data.agencies.length,
        routes: data.routes.length,
        stops: data.stops.length,
        trips: data.trips.length,
      });
    } catch (e: any) {
      setError(e.message || 'Failed to import GTFS feed');
    } finally {
      setImporting(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        {result ? (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-teal-light rounded-lg flex items-center justify-center text-xl">
                ✓
              </div>
              <div>
                <h3 className="font-heading font-bold text-lg text-dark-brown">Import Successful</h3>
              </div>
            </div>
            <div className="flex flex-col gap-2 mb-4">
              {[
                ['Routes', result.routes],
                ['Stops', result.stops],
                ['Trips', result.trips],
                ['Agencies', result.agencies],
              ].map(([label, count]) => (
                <div key={label as string} className="flex justify-between px-3 py-2 bg-cream rounded-lg text-sm">
                  <span>{label}</span>
                  <span className="font-semibold">{count}</span>
                </div>
              ))}
            </div>
            <button
              onClick={onClose}
              className="w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
            >
              Open in Editor
            </button>
          </>
        ) : (
          <>
            <h3 className="font-heading font-bold text-lg text-dark-brown mb-4">Import GTFS Feed</h3>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">
                {error}
              </div>
            )}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`border-3 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer
                ${dragging ? 'border-coral bg-coral-light' : 'border-sand bg-cream hover:border-coral hover:bg-coral-light'}`}
            >
              {importing ? (
                <p className="text-warm-gray">Importing...</p>
              ) : (
                <>
                  <div className="text-5xl mb-4">🚌</div>
                  <p className="font-heading font-bold text-dark-brown mb-2">Drop your GTFS feed here</p>
                  <p className="text-warm-gray text-sm mb-4">Upload a .zip file to start editing</p>
                  <label className="inline-flex items-center gap-2 px-4 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm cursor-pointer hover:bg-[#d4603a] transition-colors">
                    Browse Files
                    <input type="file" accept=".zip" className="hidden" onChange={handleFileInput} />
                  </label>
                </>
              )}
            </div>
            <div className="flex justify-between mt-4">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-warm-gray hover:text-dark-brown"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
