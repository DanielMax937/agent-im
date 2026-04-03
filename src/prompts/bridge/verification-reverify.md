
### Re-verification (required)
The slave submitted a new report **after fixing issues**. You must run the required verification for this mode again with the same rigor. Do not assume the previous run still holds.

**Loop until clean:** If you find any bug or mismatch, output `VERIFICATION_OUTCOME: FAILED` and list issues; the slave will fix them and you will verify again. Only emit `VERIFICATION_OUTCOME: PASSED` when there are no remaining issues.
