export interface Availability {
  onHand: number; // free_qty 向下取整、负数记 0，按映射单位
  at: number; // 从 ERP 取到的时刻（毫秒）
}

export type ErpErrorCode = 'egress' | 'timeout' | 'auth' | 'forbidden' | 'not_found' | 'invalid' | 'server' | 'bad_response' | 'cooldown';

/** 不附带底层异常、地址、响应体或凭据。 */
export class ErpError extends Error {
  constructor(public readonly code: ErpErrorCode) {
    super(code);
    this.name = 'ErpError';
  }
}

export interface ErpConnector {
  /** 按 id 批量读，至多 30 个；读不到（已删）的 id 不在结果里 */
  stock(ids: readonly number[], deadline: number): Promise<Map<number, { freeQty: number; uomId: number; active: boolean }>>;
  /** 映射用，分页读 default_code 非空、可销售的产品 */
  products(page: { offset: number; limit: number }): Promise<{ id: number; code: string; uomId: number }[]>;
  check(): Promise<{ companyCurrency: string; locationOk: boolean }>;
}
