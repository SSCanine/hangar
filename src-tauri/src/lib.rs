use tauri::Manager;

mod attach;
mod cache;
mod chats;
mod closeout;
mod pty;
mod assistant;
mod sessions;
mod inbox;
mod monitor;
mod overview;
mod phone;
mod procs;
mod registry;
mod remote;
mod roles;
mod system;
mod toolproxy;
mod uploads;
mod tools;
mod usage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a second launch (a notification's hangar:// link) hands its link to this Hangar.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match sessions::url_from_args(&argv) {
                Some(url) => sessions::deliver(app, url),
                None => sessions::deliver_focus(app),
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sessions::PendingUrl(std::sync::Mutex::new(sessions::url_from_args(&std::env::args().collect::<Vec<_>>()))))
        .setup(|app| {
            std::thread::spawn(sessions::register_protocol);
            pty::init(app.handle().clone());
            attach::install_drop_bridge(app.handle());
            let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("hangar"));
            app.manage(remote::RemoteState::new(dir));
            remote::autostart(app.handle());
            Ok(())
        })
        .manage(assistant::Streams::default())
        .invoke_handler(tauri::generate_handler![
            registry::registry_get,
            registry::registry_upsert,
            registry::registry_delete,
            tools::status_all,
            tools::tool_start,
            tools::tool_stop,
            tools::tool_focus,
            tools::tool_log,
            tools::tool_token,
            system::gpu_stats,
            system::sys_stats,
            monitor::proc_list,
            monitor::proc_kill,
            overview::system_overview,
            overview::open_system_app,
            system::projects_get,
            system::path_exists,
            system::open_folder,
            system::open_file,
            system::home_dir,
            system::clipboard_set,
            assistant::llm_models,
            assistant::chat_start,
            assistant::llm_complete,
            cache::cache_get,
            cache::cache_merge,
            inbox::inbox_read,
            sessions::session_read,
            sessions::session_stamp,
            sessions::session_resume,
            sessions::vscode_open,
            sessions::take_pending_url,
            inbox::inbox_clear,
            inbox::notify_settings_set,
            assistant::chat_cancel,
            assistant::tts,
            assistant::tts_voices,
            assistant::hook_status,
            assistant::stt,
            roles::roles_get,
            roles::roles_save,
            roles::roles_open,
            roles::ollama_loaded,
            roles::ollama_unload,
            chats::chats_list,
            chats::chats_stop,
            chats::chats_new,
            chats::chats_send,
            attach::clipboard_grab,
            attach::attach_save,
            chats::chats_open_external,
            chats::chats_done,
            closeout::chats_procs,
            closeout::chats_close,
            sessions::session_path,
            phone::phone_status,
            phone::phone_start,
            phone::phone_stop,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            usage::claude_usage,
            remote::remote_status,
            remote::remote_set,
            remote::remote_pair,
            remote::remote_pair_cancel,
            remote::remote_revoke,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Hangar")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                phone::shutdown(app);
                remote::shutdown(app);
            }
        });
}
