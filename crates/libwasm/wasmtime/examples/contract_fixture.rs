// SPDX-License-Identifier: Apache-2.0

fn main() {
    let wasm = wat::parse_str(
        r#"(module
          (memory (export "memory") 2 2)
          (func (export "kf_control_v1") (result i32) i32.const 7)
          (func (export "kf_consume_v1") (param $ptr i32) (param $len i32) (result i64)
            local.get $ptr
            i64.load8_u
            i64.const 32
            i64.shl
            local.get $ptr
            local.get $len
            i32.add
            i32.const 1
            i32.sub
            i64.load8_u
            i64.or))"#,
    )
    .expect("valid contract fixture");
    for byte in wasm {
        print!("{byte:02x}");
    }
    println!();
}
