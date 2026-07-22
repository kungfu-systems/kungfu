# Episode Admission

Episode Admission is the destination-owned protocol that moves qualified,
sealed Episodes between workspace runtimes. `Workspace Pull` and `Workspace
Push` are initiation views over the same admission core; neither grants the
source authority to overwrite the destination.

The machine-readable contract is
[`episode-admission.contract.json`](episode-admission.contract.json). The C++
implementation lives in the libkungfu runtime storage service. Python, Node,
CLI, Agent, and future GUI surfaces are adapters over that operation.

`local-direct` reads a source runtime without an intermediate file. `bundle`
and `remote-stream` supply the same Episode bundle objects through different
transport boundaries. Transport observations never enter Episode identity or
change admission dispositions.

Admission is separate from Project Cut settlement. A destination receipt may
be referenced by a later settlement, but admission does not stage, commit,
push, or remove source material.

The v1 `remote-stream` adapter is intentionally a local protocol simulation:
it proves that bundle delivery does not alter admission truth, but it does not
claim a production network service. A production adapter must negotiate the
protocol version, authenticate both workspace identities, encrypt the stream,
apply bounded backpressure, bind resume and replay to the exact plan plus a
fresh destination frontier, and keep credentials out of plans and receipts.
