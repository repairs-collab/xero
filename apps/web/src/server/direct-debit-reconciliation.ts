const providerReferencePattern =
  /^cus_[A-Za-z0-9_-]{3,120}\|sub_[A-Za-z0-9_-]{3,120}\|(pm_[A-Za-z0-9_-]{3,120}|none)$/;

export const parseDirectDebitProviderReference = (value: string): string => {
  if (value.length > 384 || !providerReferencePattern.test(value)) {
    throw new Error('DIRECT_DEBIT_RECONCILIATION_REFERENCE_REQUIRED');
  }
  return value;
};
