import React from 'react';
import { WeeklyReportPanel } from './WeeklyReportPanel';

interface WeeklyReportModalProps {
  onClose: () => void;
}

export function WeeklyReportModal({ onClose }: WeeklyReportModalProps) {
  return <WeeklyReportPanel variant="modal" onClose={onClose} />;
}
