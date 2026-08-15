# SPDX-License-Identifier: Apache-2.0

from kungfu import assignment_orchestration, initiative_family
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.initiative_family import typed_v2 as initiative_family_v2


def test_compatibility_imports_preserve_owner_identity():
    assert (
        assignment_orchestration.canonical_json is assignment_canonical.canonical_json
    )
    assert assignment_orchestration.semantic_root is assignment_canonical.semantic_root
    assert assignment_orchestration._root is assignment_canonical._root
    assert assignment_orchestration.family_contract is initiative_family.family_contract
    assert (
        assignment_orchestration.validate_family_state
        is initiative_family.validate_family_state
    )
    assert (
        assignment_orchestration.transition_family_state_v2
        is initiative_family_v2.transition_family_state_v2
    )
    assert (
        assignment_orchestration.InitiativeFamilyV1Port
        is initiative_family_v2.InitiativeFamilyV1Port
    )
