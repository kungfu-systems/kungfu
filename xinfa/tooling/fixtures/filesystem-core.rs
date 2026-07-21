// SPDX-License-Identifier: Apache-2.0

fn forbidden() {
    let _ = std::fs::read("authority.json");
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[test]
    fn fixture() {
        let _ = fs::read("fixture.json");
    }
}
