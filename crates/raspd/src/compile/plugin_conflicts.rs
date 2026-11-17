//! `discoverSkills(pluginDirs)` + `detectCommandConflicts(pluginDirs)` over
//! a published bundle's plugin directories: two plugins naming the same
//! skill or command throw in Bun, so raspd reports it as a forward.
use super::util::js_sort;
use super::{Fwd, fwd};
use crate::reads::jspath::{basename, join, relative};
use std::fs;

pub fn check_skill_and_command_conflicts(plugin_dirs: &[String]) -> Result<(), Fwd> {
    let mut skills: Vec<String> = vec![];
    for dir in plugin_dirs {
        let skills_dir = join(&[dir, "skills"]);
        if fs::metadata(&skills_dir).is_err() {
            continue;
        }
        let mut files = vec![];
        find_skill_files(&skills_dir, &mut files);
        js_sort(&mut files);
        for file in files {
            let rel = relative(&skills_dir, &file);
            let name = if rel == "SKILL.md" {
                basename(dir)
            } else if let Some(n) = rel.strip_suffix("/SKILL.md") {
                n.to_owned()
            } else {
                rel.clone()
            };
            if skills.contains(&name) {
                return Err(fwd(crate::reason!("skill_name_conflict")));
            }
            skills.push(name);
        }
    }
    let mut commands: Vec<String> = vec![];
    for dir in plugin_dirs {
        let Ok(read) = fs::read_dir(join(&[dir, "commands"])) else {
            continue;
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().is_ok_and(|t| t.is_file()) || !name.ends_with(".md") {
                continue;
            }
            let name = name.trim_end_matches(".md").to_owned();
            if commands.contains(&name) {
                return Err(fwd(crate::reason!("command_name_conflict")));
            }
            commands.push(name);
        }
    }
    Ok(())
}

fn find_skill_files(dir: &str, out: &mut Vec<String>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let full = join(&[dir, &entry.file_name().to_string_lossy()]);
        match entry.file_type() {
            Ok(t) if t.is_dir() => find_skill_files(&full, out),
            Ok(t) if t.is_file() && entry.file_name() == "SKILL.md" => out.push(full),
            _ => {}
        }
    }
}
