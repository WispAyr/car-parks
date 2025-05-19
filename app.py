def get_event_images(event_id):
    """Get the entry and exit images for an event"""
    try:
        # Get the event details
        event = db.session.query(Event).filter(Event.id == event_id).first()
        if not event:
            return None, None

        # Get the entry detection
        entry_detection = db.session.query(Detection).filter(Detection.id == event.entry_detection_id).first()
        if not entry_detection:
            return None, None

        # For through traffic events, use the same detection for both entry and exit
        if event.event_type == 'through_traffic':
            return entry_detection.image_path, entry_detection.image_path

        # For other events, get the exit detection
        exit_detection = db.session.query(Detection).filter(Detection.id == event.exit_detection_id).first()
        if not exit_detection:
            return entry_detection.image_path, None

        return entry_detection.image_path, exit_detection.image_path
    except Exception as e:
        print(f"Error getting event images: {e}")
        return None, None 