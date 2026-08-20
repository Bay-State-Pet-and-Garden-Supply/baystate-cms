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
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#211414]/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl border border-[#E8E6D9] w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden text-[#211414] animate-in fade-in zoom-in duration-150 font-sans">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#E8E6D9] bg-[#FAF9F2] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-md bg-[#14532D] flex items-center justify-center text-[#FAF9F2] font-serif font-bold text-sm shadow-xs">
              BP
            </div>
            <div>
              <h2 className="text-lg font-bold font-serif text-[#211414] leading-tight tracking-tight">
                Batch Preflight & Execution Review
              </h2>
              <div className="text-xs text-[#6B3A18] mt-0.5 flex items-center gap-2">
                <span>Batch: <strong className="text-[#211414] font-semibold">{preflight?.batchName || batchId}</strong></span>
                {preflight && (
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                    preflight.executionState === 'running' ? 'bg-[#d1fae5] text-[#14532d] border border-[#a7f3d0]' :
                    preflight.executionState === 'paused' ? 'bg-[#fef3c7] text-[#78350f] border border-[#fde68a]' :
                    preflight.executionState === 'completed' ? 'bg-[#e0f2fe] text-[#0369a1] border border-[#bae6fd]' :
                    'bg-[#f3f4f6] text-[#4b5563] border border-[#e5e7eb]'
                  }`}>
                    {preflight.executionState}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#6B3A18] hover:text-[#211414] hover:bg-[#E8E6D9]/50 transition-colors p-1.5 rounded-md"
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6 bg-[#FAF9F2]/30">
          {error && (
            <div className="p-3.5 bg-[#fee2e2] border border-[#fca5a5] rounded-md text-xs text-[#760c19] font-medium flex items-center justify-between shadow-xs">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-[#760c19] hover:opacity-75 font-bold ml-2">×</button>
            </div>
          )}

          {successMessage && (
            <div className="p-3.5 bg-[#d1fae5] border border-[#a7f3d0] rounded-md text-xs text-[#14532d] font-semibold flex items-center justify-between shadow-xs animate-in fade-in">
              <span>✓ {successMessage}</span>
              <button onClick={() => setSuccessMessage(null)} className="text-[#14532d] hover:opacity-75 font-bold ml-2">×</button>
            </div>
          )}

          {loading && !preflight ? (
            <div className="py-16 text-center text-[#6B3A18]">
              <div className="inline-block w-8 h-8 border-3 border-[#14532D] border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-sm font-medium font-serif">Analyzing batch readiness and brand profiles...</p>
            </div>
          ) : preflight ? (
            <>
              {/* Readiness Summary Banner (The General Store Hero Card) */}
              <div className="bg-[#14532D] text-[#FAF9F2] rounded-lg p-5 shadow-sm border border-[#0B3D22] relative overflow-hidden">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-[#FAF9F2]/80">
                      Execution Readiness
                    </div>
                    <div className="text-2xl font-bold font-serif tracking-tight mt-0.5 text-white">
                      {preflight.readyCount} <span className="text-sm font-normal text-[#FAF9F2]/80 font-sans">of</span> {preflight.totalItems} products ready to run
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleStartBatch('ready_only')}
                      disabled={preflight.readyCount === 0 || actionLoading !== null}
                      className="px-4 py-2.5 bg-[#F6DB12] hover:bg-[#ebd00e] active:bg-[#d8bf09] text-[#211414] font-bold text-xs rounded-sm shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {actionLoading === 'start_ready_only' ? (
                        <div className="w-4 h-4 border-2 border-[#211414] border-t-transparent rounded-full animate-spin"></div>
                      ) : (
                        <span>▶ Start {preflight.readyCount} Ready Products</span>
                      )}
                    </button>
                    <button
                      onClick={() => handleStartBatch('all')}
                      disabled={actionLoading !== null || preflight.totalItems === 0}
                      className="px-3.5 py-2.5 bg-[#FAF9F2]/10 hover:bg-[#FAF9F2]/20 active:bg-[#0B3D22] text-[#FAF9F2] font-medium text-xs rounded-sm border border-[#FAF9F2]/30 transition-colors disabled:opacity-50"
                      title="Release all items including unassigned/held items"
                    >
                      {actionLoading === 'start_all' ? 'Starting...' : 'Start All Anyway'}
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="mt-4">
                  <div className="w-full bg-[#0B3D22] rounded-full h-2 overflow-hidden border border-[#FAF9F2]/15">
                    <div
                      className="bg-[#F6DB12] h-full rounded-full transition-all duration-300"
                      style={{ width: `${readyPercent}%` }}
                    />
                  </div>
                </div>

                {/* Metrics 3-Col Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4 pt-4 border-t border-[#FAF9F2]/15 text-xs">
                  <div className="bg-[#0B3D22]/60 rounded-md p-3 border border-[#FAF9F2]/10">
                    <div className="text-[#FAF9F2]/80 text-[11px] font-medium">Brands Resolved:</div>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="font-bold text-base text-white">{preflight.metrics.brandResolvedPercent}%</span>
                      <span className="text-[#FAF9F2]/70 text-[11px]">({preflight.metrics.brandResolvedCount}/{preflight.totalItems})</span>
                    </div>
                    {preflight.metrics.ambiguousBrandCount + preflight.metrics.missingBrandCount > 0 && (
                      <div className="text-[11px] text-[#F6DB12] font-semibold mt-1 flex items-center gap-1">
                        <span>⚠</span>
                        <span>{preflight.metrics.ambiguousBrandCount + preflight.metrics.missingBrandCount} unassigned</span>
                      </div>
                    )}
                  </div>
                  <div className="bg-[#0B3D22]/60 rounded-md p-3 border border-[#FAF9F2]/10">
                    <div className="text-[#FAF9F2]/80 text-[11px] font-medium">Official Domains:</div>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="font-bold text-base text-white">{preflight.metrics.domainMappedPercent}%</span>
                      <span className="text-[#FAF9F2]/70 text-[11px]">({preflight.metrics.domainMappedCount}/{preflight.totalItems})</span>
                    </div>
                    {preflight.metrics.missingDomainBrandCount > 0 && (
                      <div className="text-[11px] text-[#F6DB12] font-semibold mt-1 flex items-center gap-1">
                        <span>⚠</span>
                        <span>{preflight.metrics.missingDomainBrandCount} missing website</span>
                      </div>
                    )}
                  </div>
                  <div className="bg-[#0B3D22]/60 rounded-md p-3 border border-[#FAF9F2]/10">
                    <div className="text-[#FAF9F2]/80 text-[11px] font-medium">Distributor Routing:</div>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="font-bold text-base text-white">{preflight.metrics.distributorRoutedPercent}%</span>
                      <span className="text-[#FAF9F2]/70 text-[11px]">({preflight.metrics.distributorRoutedCount}/{preflight.totalItems})</span>
                    </div>
                    {preflight.metrics.unroutedBrandCount > 0 && (
                      <div className="text-[11px] text-[#FAF9F2]/80 mt-1">
                        ℹ {preflight.metrics.unroutedBrandCount} brands unrouted (advisory)
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Blocker & Configuration Sections */}
              <div className="space-y-5">

                {/* Section 1: Needs Brand Assignment (Signet Burgundy Highlight) */}
                {preflight.blockers.needsBrandGroups.length > 0 && (
                  <div className="bg-white border border-[#E8E6D9] rounded-lg p-5 shadow-xs space-y-3">
                    <div className="flex items-center justify-between pb-2 border-b border-[#E8E6D9]/60">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#760C19]"></span>
                        <h3 className="text-sm font-bold font-serif text-[#211414] uppercase tracking-wider">
                          Needs Brand Assignment ({preflight.blockers.needsBrandGroups.length} groups)
                        </h3>
                      </div>
                      <span className="text-xs text-[#760C19] bg-[#fee2e2] px-2.5 py-0.5 rounded-full font-bold border border-[#fca5a5]">
                        Action Required
                      </span>
                    </div>

                    <p className="text-xs text-[#6B3A18]">
                      Products without brands cannot query distributor catalogs or discover official sites. Assign brands to unblock automation.
                    </p>

                    <div className="space-y-3 pt-1">
                      {preflight.blockers.needsBrandGroups.map((group) => {
                        const currentInput = brandInputs[group.key] ?? group.suggestedBrand ?? '';
                        const isActionRunning = actionLoading === `assign_${group.key}`;
                        return (
                          <div
                            key={group.key}
                            className="bg-[#FAF9F2]/60 border border-[#E8E6D9] rounded-md p-3.5 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3"
                          >
                            <div className="space-y-1.5 max-w-lg">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-[#6B3A18]">Suggested Brand:</span>
                                <span className="text-xs font-bold text-[#14532D] bg-white border border-[#E8E6D9] px-2 py-0.5 rounded">
                                  {group.suggestedBrand || 'Unassigned'}
                                </span>
                                <span className="text-xs font-bold text-[#760C19] bg-[#fee2e2] px-2 py-0.5 rounded-full border border-[#fca5a5]">
                                  {group.itemCount} {group.itemCount === 1 ? 'product' : 'products'}
                                </span>
                              </div>
                              {group.sampleProductNames.length > 0 && (
                                <div className="text-xs text-[#6B3A18] italic truncate">
                                  Samples: {group.sampleProductNames.join(' · ')}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2 w-full md:w-auto">
                              <input
                                type="text"
                                value={currentInput}
                                onChange={(e) => setBrandInputs({ ...brandInputs, [group.key]: e.target.value })}
                                placeholder="Enter brand name"
                                className="px-3 py-1.5 text-xs bg-white border border-[#E8E6D9] rounded-sm focus:ring-1 focus:ring-[#14532D] focus:border-[#14532D] text-[#211414] flex-1 md:w-48"
                              />
                              <button
                                onClick={() => handleAssignBrand(group)}
                                disabled={isActionRunning || !currentInput.trim()}
                                className="px-3.5 py-1.5 bg-[#14532D] hover:bg-[#0B3D22] text-[#FAF9F2] text-xs font-bold rounded-sm shadow-xs transition-colors whitespace-nowrap disabled:opacity-50"
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

                {/* Section 2: Missing Official Domains (Muted Gold Highlight) */}
                {preflight.blockers.missingDomainBrands.length > 0 && (
                  <div className="bg-white border border-[#E8E6D9] rounded-lg p-5 shadow-xs space-y-3">
                    <div className="flex items-center justify-between pb-2 border-b border-[#E8E6D9]/60">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#E9B520]"></span>
                        <h3 className="text-sm font-bold font-serif text-[#211414] uppercase tracking-wider">
                          Missing Official Domain ({preflight.blockers.missingDomainBrands.length} brands)
                        </h3>
                      </div>
                      <span className="text-xs text-[#78350f] bg-[#fef3c7] px-2.5 py-0.5 rounded-full font-semibold border border-[#fde68a]">
                        Discovery Stage Target
                      </span>
                    </div>

                    <p className="text-xs text-[#6B3A18]">
                      Providing the manufacturer website ensures discovery finds official product pages for scraping.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                      {preflight.blockers.missingDomainBrands.map((blocker) => {
                        const currentInput = domainInputs[blocker.brand] ?? '';
                        const isActionRunning = actionLoading === `domain_${blocker.brand}`;
                        return (
                          <div
                            key={blocker.brand}
                            className="bg-[#FAF9F2]/60 border border-[#E8E6D9] rounded-md p-3 shadow-2xs flex flex-col justify-between gap-2.5"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-bold text-[#211414]">{blocker.brand}</span>
                              <span className="text-xs text-[#6B3A18] bg-white border border-[#E8E6D9] px-2 py-0.5 rounded">
                                {blocker.itemCount} products
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={currentInput}
                                onChange={(e) => setDomainInputs({ ...domainInputs, [blocker.brand]: e.target.value })}
                                placeholder="e.g. brandname.com"
                                className="px-3 py-1 text-xs bg-white border border-[#E8E6D9] rounded-sm focus:ring-1 focus:ring-[#14532D] focus:border-[#14532D] text-[#211414] flex-1"
                              />
                              <button
                                onClick={() => handleSaveDomain(blocker)}
                                disabled={isActionRunning || !currentInput.trim()}
                                className="px-3 py-1 bg-[#14532D] hover:bg-[#0B3D22] text-[#FAF9F2] text-xs font-bold rounded-sm shadow-xs transition-colors whitespace-nowrap disabled:opacity-50"
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

                {/* Section 3: Distributor Routing Config (Uniform Green Highlight) */}
                {preflight.blockers.unroutedBrands.length > 0 && preflight.availableDistributors.length > 0 && (
                  <div className="bg-white border border-[#E8E6D9] rounded-lg p-5 shadow-xs space-y-3">
                    <div className="flex items-center justify-between pb-2 border-b border-[#E8E6D9]/60">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#14532D]"></span>
                        <h3 className="text-sm font-bold font-serif text-[#211414] uppercase tracking-wider">
                          Distributor Sourcing Policy ({preflight.blockers.unroutedBrands.length} brands)
                        </h3>
                      </div>
                      <span className="text-xs text-[#6B3A18] bg-[#FAF9F2] border border-[#E8E6D9] px-2.5 py-0.5 rounded-full font-semibold">
                        Advisory / Optional
                      </span>
                    </div>

                    <div className="space-y-3 pt-1">
                      {preflight.blockers.unroutedBrands.map((blocker) => {
                        const currentPref = routingPreferences[blocker.brand] || {
                          distributorIds: blocker.preferredDistributorIds,
                          policy: blocker.sourcingPolicy,
                        };
                        const isActionRunning = actionLoading === `routing_${blocker.brand}`;

                        return (
                          <div
                            key={blocker.brand}
                            className="bg-[#FAF9F2]/60 border border-[#E8E6D9] rounded-md p-3.5 shadow-2xs space-y-2.5"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-[#211414]">{blocker.brand}</span>
                                <span className="text-xs text-[#6B3A18] bg-white border border-[#E8E6D9] px-2 py-0.5 rounded">
                                  {blocker.itemCount} products
                                </span>
                              </div>
                              <button
                                onClick={() => handleSaveRouting(blocker)}
                                disabled={isActionRunning}
                                className="px-3 py-1 bg-[#14532D] hover:bg-[#0B3D22] text-[#FAF9F2] text-xs font-bold rounded-sm shadow-xs transition-colors disabled:opacity-50"
                              >
                                {isActionRunning ? 'Saving...' : 'Save Routing'}
                              </button>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-[#E8E6D9]/60">
                              {/* Distributor selection checkboxes */}
                              <div>
                                <label className="text-[11px] font-semibold text-[#6B3A18] block mb-1">
                                  Preferred Distributors:
                                </label>
                                <div className="flex flex-wrap gap-2">
                                  {preflight.availableDistributors.map((dist) => {
                                    const isChecked = currentPref.distributorIds.includes(dist.distributorId);
                                    return (
                                      <label
                                        key={dist.id}
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs cursor-pointer border transition-colors ${
                                          isChecked
                                            ? 'bg-[#d1fae5] border-[#14532D] text-[#14532D] font-bold'
                                            : 'bg-white border-[#E8E6D9] text-[#6B3A18] hover:bg-[#FAF9F2]'
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
                                          className="rounded text-[#14532D] focus:ring-[#14532D]"
                                        />
                                        <span>{dist.distributorId}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Policy select */}
                              <div>
                                <label className="text-[11px] font-semibold text-[#6B3A18] block mb-1">
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
                                  className="w-full text-xs px-2.5 py-1.5 border border-[#E8E6D9] rounded-sm bg-white text-[#211414] focus:ring-1 focus:ring-[#14532D]"
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
        <div className="px-6 py-4 border-t border-[#E8E6D9] bg-[#FAF9F2] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[#6B3A18]">
          <div>
            {preflight?.heldCount ? (
              <span>
                <strong className="text-[#760C19] font-bold">{preflight.heldCount} products</strong> will remain held until brands are assigned.
              </span>
            ) : (
              <span className="text-[#14532D] font-medium">All products are configured and ready to run.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-[#E8E6D9] bg-white text-[#211414] hover:bg-[#FAF9F2] rounded-sm font-semibold transition-colors"
            >
              Keep as Draft / Close
            </button>
            {preflight && preflight.readyCount > 0 && (
              <button
                onClick={() => handleStartBatch('ready_only')}
                disabled={actionLoading !== null}
                className="px-4 py-2 bg-[#14532D] hover:bg-[#0B3D22] text-[#FAF9F2] font-bold rounded-sm shadow-xs transition-colors"
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
