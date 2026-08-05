# Security policy

## Security properties

SAFAST removes the network path between sender and receiver. It does **not**
provide confidentiality by itself. Any camera with line of sight to the sending
screen can capture the same QR frames.

The receiver validates three layers before offering a file:

1. strict frame dimensions and stream identity;
2. FNV-1a of the reconstructed DCF2 container;
3. SHA-256 of the original uncompressed file.

Gzip decompression is bounded by the declared original length and the hard
64 MB file limit.

## Reporting

Do not publish an exploit before maintainers have had a reasonable opportunity
to assess it. Open a private GitHub security advisory for `netzerolabs/safast`
with reproduction steps, affected versions, and expected impact.
