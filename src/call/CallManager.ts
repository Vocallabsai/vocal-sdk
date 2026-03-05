/**
 * Call Manager
 * Handles call state management
 */

import { CallData } from '../types';
import { Logger } from '../utils/logger';

export class CallManager {
  private logger: Logger;
  private currentCall: CallData | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Set current call
   */
  setCurrentCall(callData: CallData): void {
    this.currentCall = callData;
    this.logger.info(`Call set: ${callData.call_id}`);
  }

  /**
   * Get current call
   */
  getCurrentCall(): CallData | null {
    return this.currentCall;
  }

  /**
   * Clear current call
   */
  clearCurrentCall(): void {
    this.logger.info('Clearing current call');
    this.currentCall = null;
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.currentCall = null;
  }
}
