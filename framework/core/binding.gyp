{
  "variables": {
    "gyp_dir": "<(module_root_dir)/.gyp",
    "uv_inputs": [
      "<(module_root_dir)/pyproject.toml",
      "<(module_root_dir)/uv.lock"
    ],
    "conan_inputs": [
      "<@(uv_inputs)",
      "<(module_root_dir)/conanfile.py"
    ],
    "module_inputs": [
      "<(module_root_dir)/conanfile.py",
      "<!@(node -p \"require('glob').sync('**/CMakeLists.txt', {ignore:'build/**'}).join(' ');\")",
      "<!@(node -p \"require('glob').sync('**/*.*(h|hpp|c|cc|cpp)', {ignore:'build/**'}).join(' ');\")"
    ],
    "drone_inputs": [
      "<!@(node -p \"require('glob').sync('src/bindings/drone/**/*.cpp').join(' ');\")"
    ],
    "wheel_inputs": [
      "<@(uv_inputs)",
      "<@(module_inputs)",
      "<!@(node -p \"require('glob').sync('src/python/**/*.*(py|spec)').join(' ');\")"
    ],
    "kungfu_inputs": [
      "<@(wheel_inputs)"
    ]
  },
  "targets": [
    {
      "target_name": "uv",
      "type": "none",
      "actions": [
        {
          "action_name": "sync",
          "inputs": [
            "<(module_root_dir)/pyproject.toml"
          ],
          "outputs": [
            "<(module_root_dir)/uv.lock"
          ],
          "action": [
            "python",
            "<(gyp_dir)/gyp_action_uv.py"
          ]
        }
      ]
    },
    {
      "target_name": "conan",
      "type": "none",
      "dependencies": [
        "uv"
      ],
      "actions": [
        {
          "action_name": "configure",
          "inputs": [
            "<@(conan_inputs)"
          ],
          "outputs": [
            "<(module_root_dir)/build/conan.lock"
          ],
          "action": [
            "python",
            "<(gyp_dir)/gyp_action_pnpm.py",
            "configure"
          ]
        }
      ]
    },
    {
      "target_name": "<(module_name)",
      "type": "none",
      "dependencies": [
        "conan"
      ],
      "actions": [
        {
          "action_name": "compile",
          "inputs": [
            "<@(module_inputs)"
          ],
          "outputs": [
            "<(PRODUCT_DIR)/kungfubuildinfo.json"
          ],
          "action": [
            "python",
            "<(gyp_dir)/gyp_action_pnpm.py",
            "compile"
          ]
        }
      ]
    },
    {
      "target_name": "node_link",
      "type": "none",
      "dependencies": [
        "conan"
      ],
      "actions": [
        {
          "action_name": "link",
          "inputs": [
            "package.json"
          ],
          "outputs": [
            "<(PRODUCT_DIR)/libnodebuildinfo.json"
          ],
          "action": [
            "python",
            "<(gyp_dir)/gyp_action_pnpm.py",
            "link-node"
          ]
        }
      ]
    },
    {
      "target_name": "wheel",
      "type": "none",
      "dependencies": [
        "uv",
        "<(module_name)",
        "node_link"
      ],
      "actions": [
        {
          "action_name": "wheel",
          "inputs": [
            "<@(wheel_inputs)"
          ],
          "outputs": [
            "<(module_root_dir)/build/python/kungfubuildinfo.json"
          ],
          "action": [
            "python",
            "<(gyp_dir)/gyp_action_pnpm.py",
            "wheel"
          ]
        }
      ]
    },
    {
      "target_name": "kfc",
      "type": "none",
      "dependencies": [
        "wheel"
      ],
      "actions": [
        {
          "action_name": "freeze",
          "inputs": [
            "<@(kungfu_inputs)"
          ],
          "outputs": [
            "<(module_path)/kungfubuildinfo.json"
          ],
          "action": [
            "python",
            "<(gyp_dir)/gyp_action_pnpm.py",
            "freeze"
          ]
        }
      ]
    }
  ]
}
