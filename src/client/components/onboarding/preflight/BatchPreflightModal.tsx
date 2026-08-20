import React, { useState, useEffect, useCallback } from 'react';
import {
  getBatchPreflight,
  startBatch,
  assignBrandGroup,
  configureBrand,
} from '../../../onboarding-api';
import type {
  BatchPreflightResponse,
  PreflightBrandGroup,
  PreflightDomainBlocker,
  PreflightRoutingBlocker,
  SourcingPolicy,
} from '../../../../shared/schemas/onboarding';

interface BatchPreflightModalProps {
  batchId: string;
  isOpen: boolean;
  onClose: () => void;
  onBatchStarted?: () => void;
}

export const BatchPreflightModal: React.FC<BatchPreflightModalProps> = ({
  batchId,
  isOpen,
  onClose,
  onBatchStarted,
}) => {
  const [preflight, setPreflight] = useState<BatchPreflightResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form states per card
  const [brandInputs, setBrandInputs] = useState<Record<string, string>>({});
  const [domainInputs, setDomainInputs] = useState<Record<string, string>>({});
  const [routingPreferences, setRoutingPreferences] = useState<Record<string, { distributorIds: string[]; policy: SourcingPolicy }>>({});

  const fetchPreflight = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getBatchPreflight(batchId);
      setPreflight(data);

      // Initialize inputs from data
      const bInputs: Record<string, string> = {};
      data.blockers.needsBrandGroups.forEach((g) => {
        bInputs[g.key] = g.suggestedBrand || '';
      });
      setBrandInputs(bInputs);

      const rPrefs: Record<string, { distributorIds: string[]; policy: SourcingPolicy }> = {};
      data.blockers.unroutedBrands.forEach((b) => {
        rPrefs[b.brand] = {
          distributorIds: b.preferredDistributorIds || [],
          policy: b.sourcingPolicy || 'preferred_then_fallback',
        };
      });
      setRoutingPreferences(rPrefs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    if (isOpen) {
      fetchPreflight();
    }
  }, [isOpen, fetchPreflight]);

  if (!isOpen) return null;

  const handleStartBatch = async (mode: 'ready_only' | 'all') => {
    try {
      setActionLoading(`start_${mode}`);
      setError(null);
      await startBatch(batchId, mode);
      setSuccessMessage(mode === 'ready_only' ? 'Batch started with ready products!' : 'Batch started with all products!');
      if (onBatchStarted) {
        onBatchStarted();
      }
      setTimeout(() => {
        onClose();
      }, 750);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleAssignBrand = async (group: PreflightBrandGroup) => {
    const brand = (brandInputs[group.key] || group.suggestedBrand || '').trim();
    if (!brand) {
      alert('Please enter a brand name');
      return;
    }
    try {
      setActionLoading(`assign_${group.key}`);
      setError(null);
      const res = await assignBrandGroup(batchId, group.itemIds, brand);
      setPreflight(res.preflight);
      setSuccessMessage(`Assigned brand "${brand}" to ${group.itemCount} products`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleSaveDomain = async (blocker: PreflightDomainBlocker) => {
    const domain = (domainInputs[blocker.brand] || '').trim();
    if (!domain) {
      alert('Please enter an official domain');
      return;
    }
    try {
      setActionLoading(`domain_${blocker.brand}`);
      setError(null);
      const res = await configureBrand(batchId, { brand: blocker.brand, domain });
      setPreflight(res.preflight);
      setSuccessMessage(`Saved domain "${domain}" for ${blocker.brand}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleSaveRouting = async (blocker: PreflightRoutingBlocker) => {
    const pref = routingPreferences[blocker.brand] || {
      distributorIds: blocker.preferredDistributorIds,
      policy: blocker.sourcingPolicy,
    };
    try {
      setActionLoading(`routing_${blocker.brand}`);
      setError(null);
      const res = await configureBrand(batchId, {
        brand: blocker.brand,
        preferredDistributorIds: pref.distributorIds,
        sourcingPolicy: pref.policy,
      });
      setPreflight(res.preflight);
      setSuccessMessage(`Saved distributor routing for ${blocker.brand}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const readyPercent = preflight && preflight.totalItems > 0
    ? Math.round((preflight.readyCount / preflight.totalItems) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden text-gray-800 animate-in fade-in zoom-in duration-150">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-800 flex items-center justify-center text-white font-bold text-sm shadow-sm">
              BP
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 leading-tight">Batch Preflight & Release Review</h2>
              <p className="text-xs text-gray-500">
                Batch: <span className="font-semibold text-gray-700">{preflight?.batchName || batchId}</span>
                {preflight && (
                  <span className={`ml-2 px-2 py-0.5 rounded text-[11px] font-medium ${
                    preflight.executionState === 'running' ? 'bg-emerald-100 text-emerald-800' :
                    preflight.executionState === 'paused' ? 'bg-amber-100 text-amber-800' :
                    preflight.executionState === 'completed' ? 'bg-blue-100 text-blue-800' :
                    'bg-gray-200 text-gray-700'
                  }`}>
                    {preflight.executionState.toUpperCase()}
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1.5 rounded-lg hover:bg-gray-200"
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {error && (
            <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700 font-bold ml-2">×</button>
            </div>
          )}

          {successMessage && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-800 flex items-center justify-between animate-in fade-in">
              <span>✓ {successMessage}</span>
              <button onClick={() => setSuccessMessage(null)} className="text-emerald-600 hover:text-emerald-800 font-bold ml-2">×</button>
            </div>
          )}

          {loading && !preflight ? (
            <div className="py-16 text-center text-gray-500">
              <div className="inline-block w-8 h-8 border-3 border-emerald-700 border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-sm font-medium">Analyzing batch readiness and brand profiles...</p>
            </div>
          ) : preflight ? (
            <>
              {/* Readiness Summary Banner */}
              <div className="bg-gradient-to-r from-emerald-900 to-emerald-800 text-white rounded-xl p-5 shadow-sm border border-emerald-950/20">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wider font-semibold text-emerald-200">Execution Readiness</div>
                    <div className="text-2xl font-extrabold tracking-tight mt-0.5">
                      {preflight.readyCount} <span className="text-sm font-normal text-emerald-200">of</span> {preflight.totalItems} products ready to run
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleStartBatch('ready_only')}
                      disabled={preflight.readyCount === 0 || actionLoading !== null}
                      className="px-4 py-2.5 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-gray-950 font-bold text-sm rounded-lg shadow transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {actionLoading === 'start_ready_only' ? (
                        <div className="w-4 h-4 border-2 border-gray-950 border-t-transparent rounded-full animate-spin"></div>
                      ) : (
                        <span>▶ Start {preflight.readyCount} Ready Products</span>
                      )}
                    </button>
                    <button
                      onClick={() => handleStartBatch('all')}
                      disabled={actionLoading !== null || preflight.totalItems === 0}
                      className="px-3.5 py-2.5 bg-emerald-700/80 hover:bg-emerald-700 active:bg-emerald-950 text-white font-medium text-xs rounded-lg border border-emerald-600 transition-colors disabled:opacity-50"
                      title="Release all items including unassigned/held items"
                    >
                      {actionLoading === 'start_all' ? 'Starting...' : 'Start All Anyway'}
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="mt-4">
                  <div className="w-full bg-emerald-950/40 rounded-full h-2 overflow-hidden border border-emerald-700/50">
                    <div
                      className="bg-amber-400 h-full rounded-full transition-all duration-300"
                      style={{ width: `${readyPercent}%` }}
                    />
                  </div>
                </div>

                {/* Metrics 3-Col Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4 pt-4 border-t border-emerald-700/50 text-xs">
                  <div className="bg-emerald-950/30 rounded-lg p-2.5">
                    <span className="text-emerald-300">Brands Resolved:</span>{' '}
                    <span className="font-bold text-white">{preflight.metrics.brandResolvedPercent}%</span>{' '}
                    <span className="text-emerald-200">({preflight.metrics.brandResolvedCount}/{preflight.totalItems})</span>
                    {preflight.metrics.ambiguousBrandCount + preflight.metrics.missingBrandCount > 0 && (
                      <div className="text-[11px] text-amber-300 mt-0.5">
                        ⚠ {preflight.metrics.ambiguousBrandCount + preflight.metrics.missingBrandCount} unassigned
                      </div>
                    )}
                  </div>
                  <div className="bg-emerald-950/30 rounded-lg p-2.5">
                    <span className="text-emerald-300">Official Domains:</span>{' '}
                    <span className="font-bold text-white">{preflight.metrics.domainMappedPercent}%</span>{' '}
                    <span className="text-emerald-200">({preflight.metrics.domainMappedCount}/{preflight.totalItems})</span>
                    {preflight.metrics.missingDomainBrandCount > 0 && (
                      <div className="text-[11px] text-amber-300 mt-0.5">
                        ⚠ {preflight.metrics.missingDomainBrandCount} brands missing site
                      </div>
                    )}
                  </div>
                  <div className="bg-emerald-950/30 rounded-lg p-2.5">
                    <span className="text-emerald-300">Distributor Routing:</span>{' '}
                    <span className="font-bold text-white">{preflight.metrics.distributorRoutedPercent}%</span>{' '}
                    <span className="text-emerald-200">({preflight.metrics.distributorRoutedCount}/{preflight.totalItems})</span>
                    {preflight.metrics.unroutedBrandCount > 0 && (
                      <div className="text-[11px] text-emerald-200 mt-0.5">
                        ℹ {preflight.metrics.unroutedBrandCount} brands unrouted (advisory)
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Exception Management Sections */}
              <div className="space-y-6">

                {/* Section 1: Needs Brand Assignment */}
                {preflight.blockers.needsBrandGroups.length > 0 && (
                  <div className="border border-amber-200 rounded-xl p-4 bg-amber-50/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                        <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
                          Needs Brand Assignment ({preflight.blockers.needsBrandGroups.length} groups)
                        </h3>
                      </div>
                      <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded font-medium">
                        Prevents auto-sourcing
                      </span>
                    </div>

                    <div className="space-y-3">
                      {preflight.blockers.needsBrandGroups.map((group) => {
                        const currentInput = brandInputs[group.key] ?? group.suggestedBrand ?? '';
                        const isActionRunning = actionLoading === `assign_${group.key}`;
                        return (
                          <div
                            key={group.key}
                            className="bg-white border border-amber-200/80 rounded-lg p-3.5 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3"
                          >
                            <div className="space-y-1 max-w-lg">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-gray-500">Suggested Brand:</span>
                                <span className="text-sm font-bold text-gray-900 bg-gray-100 px-2 py-0.5 rounded">
                                  {group.suggestedBrand || 'Unidentified'}
                                </span>
                                <span className="text-xs font-medium text-amber-700 bg-amber-100/70 px-2 py-0.5 rounded-full">
                                  {group.itemCount} {group.itemCount === 1 ? 'product' : 'products'}
                                </span>
                              </div>
                              <div className="text-xs text-gray-500 italic truncate">
                                Samples: {group.sampleProductNames.join(', ')}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 w-full md:w-auto">
                              <input
                                type="text"
                                value={currentInput}
                                onChange={(e) => setBrandInputs({ ...brandInputs, [group.key]: e.target.value })}
                                placeholder="Enter brand name"
                                className="px-3 py-1.5 text-xs border border-gray-300 rounded-md focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600 flex-1 md:w-48"
                              />
                              <button
                                onClick={() => handleAssignBrand(group)}
                                disabled={isActionRunning || !currentInput.trim()}
                                className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 active:bg-emerald-900 text-white text-xs font-bold rounded-md shadow-sm transition-colors whitespace-nowrap disabled:opacity-50"
                              >
                                {isActionRunning ? 'Assigning...' : `Assign all ${group.itemCount}`}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Section 2: Missing Official Domains */}
                {preflight.blockers.missingDomainBrands.length > 0 && (
                  <div className="border border-blue-200 rounded-xl p-4 bg-blue-50/30 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                        <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
                          Missing Official Domain ({preflight.blockers.missingDomainBrands.length} brands)
                        </h3>
                      </div>
                      <span className="text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded font-medium">
                        Used for Discovery stage
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {preflight.blockers.missingDomainBrands.map((blocker) => {
                        const currentInput = domainInputs[blocker.brand] ?? '';
                        const isActionRunning = actionLoading === `domain_${blocker.brand}`;
                        return (
                          <div
                            key={blocker.brand}
                            className="bg-white border border-blue-200/80 rounded-lg p-3 shadow-sm flex flex-col justify-between gap-2.5"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-bold text-gray-900">{blocker.brand}</span>
                              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                                {blocker.itemCount} products
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={currentInput}
                                onChange={(e) => setDomainInputs({ ...domainInputs, [blocker.brand]: e.target.value })}
                                placeholder="e.g. brandname.com"
                                className="px-3 py-1 text-xs border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-600 focus:border-blue-600 flex-1"
                              />
                              <button
                                onClick={() => handleSaveDomain(blocker)}
                                disabled={isActionRunning || !currentInput.trim()}
                                className="px-3 py-1 bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold rounded-md shadow-sm transition-colors whitespace-nowrap disabled:opacity-50"
                              >
                                {isActionRunning ? 'Saving...' : 'Save Site'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Section 3: Distributor Routing Config */}
                {preflight.blockers.unroutedBrands.length > 0 && preflight.availableDistributors.length > 0 && (
                  <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
                        <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
                          Distributor Sourcing Policy ({preflight.blockers.unroutedBrands.length} brands)
                        </h3>
                      </div>
                      <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded font-medium">
                        Optional / Advisory
                      </span>
                    </div>

                    <div className="space-y-3">
                      {preflight.blockers.unroutedBrands.map((blocker) => {
                        const currentPref = routingPreferences[blocker.brand] || {
                          distributorIds: blocker.preferredDistributorIds,
                          policy: blocker.sourcingPolicy,
                        };
                        const isActionRunning = actionLoading === `routing_${blocker.brand}`;

                        return (
                          <div
                            key={blocker.brand}
                            className="bg-white border border-gray-200 rounded-lg p-3.5 shadow-sm space-y-2.5"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-gray-900">{blocker.brand}</span>
                                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                                  {blocker.itemCount} products
                                </span>
                              </div>
                              <button
                                onClick={() => handleSaveRouting(blocker)}
                                disabled={isActionRunning}
                                className="px-3 py-1 bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-bold rounded-md shadow-sm transition-colors disabled:opacity-50"
                              >
                                {isActionRunning ? 'Saving...' : 'Save Routing'}
                              </button>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 border-t border-gray-100">
                              {/* Distributor selection checkboxes */}
                              <div>
                                <label className="text-[11px] font-semibold text-gray-600 block mb-1">
                                  Preferred Distributors:
                                </label>
                                <div className="flex flex-wrap gap-2">
                                  {preflight.availableDistributors.map((dist) => {
                                    const isChecked = currentPref.distributorIds.includes(dist.distributorId);
                                    return (
                                      <label
                                        key={dist.id}
                                        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer border transition-colors ${
                                          isChecked
                                            ? 'bg-emerald-50 border-emerald-400 text-emerald-900 font-semibold'
                                            : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                                        }`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={(e) => {
                                            const updatedIds = e.target.checked
                                              ? [...currentPref.distributorIds, dist.distributorId]
                                              : currentPref.distributorIds.filter((id) => id !== dist.distributorId);
                                            setRoutingPreferences({
                                              ...routingPreferences,
                                              [blocker.brand]: {
                                                ...currentPref,
                                                distributorIds: updatedIds,
                                              },
                                            });
                                          }}
                                          className="rounded text-emerald-700 focus:ring-emerald-600"
                                        />
                                        <span>{dist.distributorId}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Policy select */}
                              <div>
                                <label className="text-[11px] font-semibold text-gray-600 block mb-1">
                                  Routing Policy:
                                </label>
                                <select
                                  value={currentPref.policy}
                                  onChange={(e) => {
                                    setRoutingPreferences({
                                      ...routingPreferences,
                                      [blocker.brand]: {
                                        ...currentPref,
                                        policy: e.target.value as SourcingPolicy,
                                      },
                                    });
                                  }}
                                  className="w-full text-xs px-2.5 py-1.5 border border-gray-300 rounded-md bg-white focus:ring-1 focus:ring-emerald-600"
                                >
                                  <option value="preferred_then_fallback">
                                    Preferred first, then fallback (Recommended)
                                  </option>
                                  <option value="preferred_only">Preferred only</option>
                                  <option value="advisory">Advisory / Query all</option>
                                </select>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              </div>
            </>
          ) : null}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-gray-200 bg-gray-50 flex items-center justify-between text-xs text-gray-500">
          <div>
            {preflight?.heldCount ? (
              <span>
                <strong className="text-amber-700">{preflight.heldCount} products</strong> will remain held until brands are assigned.
              </span>
            ) : (
              <span>All products are configured and ready.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-colors"
            >
              Keep as Draft / Close
            </button>
            {preflight && preflight.readyCount > 0 && (
              <button
                onClick={() => handleStartBatch('ready_only')}
                disabled={actionLoading !== null}
                className="px-4 py-2 bg-emerald-800 hover:bg-emerald-700 text-white font-bold rounded-lg shadow-sm transition-colors"
              >
                Start {preflight.readyCount} Ready Products
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
